// Kill whatever listens on a TCP port, without assuming lsof exists.
//
// The launcher frees the app port at startup before spawning its own server.
// The old implementation used only `lsof -ti:<port>`; on Termux lsof is
// usually absent, so the call threw and the port was silently left held —
// an orphaned next-server child then kept the port and the new server died
// with EADDRINUSE while the CLI printed "running".
//
// Order per platform:
//   - Windows: netstat is a system tool, so ask it for the LISTENING PIDs
//     on the port and taskkill them. (The original complainer was on
//     Windows — C:\Users\Administrator, Node v24.22.1 — where lsof and
//     fuser do not exist at all, so the lsof-only cleanup was a silent
//     no-op there too.)
//   - macOS/Linux: lsof first (kills ALL pids, not just the first).
//   - Linux without lsof (Termux and other minimal installs): a pure-Node
//     /proc fallback (reads /proc/net/tcp{,6} for LISTENING sockets on the
//     port, maps socket inodes to PIDs via /proc/<pid>/fd).
//   - macOS without lsof: no fallback — macOS has no /proc, and the only
//     built-in port-to-PID map (`netstat -anv -p tcp`) is not parsed here;
//     the call resolves quietly and the readiness gate reports the real
//     failure instead. lsof ships with macOS, so this is a corner case.
//
// `exec` and `platform` are injectable so tests can drive the Windows path
// on Linux (there is no Windows machine here): pass { exec, platform }.
// Defaults are the real ones, so callers just pass the port.
const childProcess = require("child_process");
const fs = require("fs");

const DEFAULT_EXEC = (cmd, opts) => childProcess.execSync(cmd, opts);

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function isLsofMissingError(err) {
  const msg = String((err && err.message) || err || "");
  return err && (err.code === "ENOENT" || err.status === 127 || /not found/i.test(msg) || /ENOENT/.test(msg));
}

// PIDs of processes LISTENING on a TCP port, parsed from `netstat -ano`
// output (Windows). Strict parse — the local-address port must equal the
// target exactly, so a listener on :2012 or an ESTABLISHED connection to
// :20127 never matches. Returns [] on empty/unparsable output.
function parseNetstatListeningPids(output, port) {
  const want = String(Number(port));
  const pids = [];
  for (const line of String(output || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    // TCP  <local>  <foreign>  LISTENING  <pid>
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== "TCP") continue;
    if (parts[3].toUpperCase() !== "LISTENING") continue;
    const local = parts[1] || "";
    if (local.slice(local.lastIndexOf(":") + 1) !== want) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

// PIDs listening on a TCP port on Windows, via netstat. [] when the port
// is free or netstat itself fails.
function findListenerPidsWindows(port, execFn = DEFAULT_EXEC) {
  let output;
  try {
    output = execFn("netstat -ano", { encoding: "utf8", shell: true, windowsHide: true, timeout: 5000 });
  } catch { return []; }
  return parseNetstatListeningPids(output, port);
}

// True when a LISTEN socket exists on the port (Windows, netstat).
function isPortListeningWindows(port, execFn = DEFAULT_EXEC) {
  return findListenerPidsWindows(port, execFn).length > 0;
}

function killPidsWindows(pids, execFn = DEFAULT_EXEC) {
  for (const pid of pids) {
    try { execFn(`taskkill /F /PID ${pid}`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 }); } catch { /* already dead or no permission */ }
  }
}

// PIDs of processes listening on a TCP port, via /proc (Linux only).
// Returns [] when /proc is unavailable (non-Linux) or nothing listens.
function findListenerPidsLinux(port) {
  const want = Number(port).toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const local = parts[1] || "";
      const state = parts[3] || "";
      const inode = parts[9] || "";
      if (state !== "0A") continue; // LISTEN only
      const portHex = (local.split(":")[1] || "").toUpperCase();
      if (portHex === want && inode) inodes.add(inode);
    }
  }
  if (!inodes.size) return [];
  const pids = [];
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue; // never kill ourselves
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) { pids.push(pid); break; }
    }
  }
  return [...new Set(pids)];
}

function killPids(pids) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

// True when a LISTEN socket exists on the port (Linux, /proc only).
function isPortListeningLinux(port) {
  const want = Number(port).toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const local = parts[1] || "";
      if (parts[3] === "0A" && (local.split(":")[1] || "").toUpperCase() === want) return true;
    }
  }
  return false;
}

// True once nothing listens on the port (or the deadline passes). Fully
// synchronous — a TCP probe cannot work here because the launcher blocks the
// event loop while it waits. Non-Linux non-Windows (macOS) falls back to the
// old fixed sleep: there is no /proc and no netstat parser here.
function waitPortFree(port, timeoutMs = 2000, { exec: execFn = DEFAULT_EXEC, platform = process.platform } = {}) {
  if (platform === "win32") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isPortListeningWindows(port, execFn)) return true;
      sleepSync(100);
    }
    return !isPortListeningWindows(port, execFn);
  }
  if (platform !== "linux") { sleepSync(500); return false; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPortListeningLinux(port)) return true;
    sleepSync(100);
  }
  return !isPortListeningLinux(port);
}

// Kill any process on a specific port. Resolves when the port is free or
// the wait expires — never throws, so startup is never blocked by cleanup.
function killProcessOnPort(port, { exec: execFn = DEFAULT_EXEC, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    try {
      if (platform === "win32") {
        killPidsWindows(findListenerPidsWindows(port, execFn), execFn);
      } else {
        // macOS/Linux: lsof first.
        let lsofPids = null;
        // macOS/Linux: lsof first. -sTCP:LISTEN is load-bearing: plain
        // `lsof -ti:<port>` lists ANY socket involving the port, including
        // a client connected TO it — in the Hide-to-Tray flow the parent
        // CLI probes /api/health while the tray child runs this cleanup,
        // and against a never-responding listener each probe hangs for its
        // full 1s timeout, so the parent was listed and SIGKILLed by its
        // own child (hide-blocked, 2026-11-12: parent exited code=-9).
        // LISTEN-only matches the /proc fallback and the Windows netstat
        // parser, which both already filter to listeners.
        let lsofMissing = false;
        try {
          const pidOutput = execFn(`lsof -ti:${port} -sTCP:LISTEN`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
          }).trim();
          lsofPids = pidOutput ? pidOutput.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        } catch (e) {
          // lsof exits non-zero both when the port is free and when the
          // binary is missing — only the missing case needs the fallback.
          lsofMissing = isLsofMissingError(e);
          lsofPids = [];
        }
        if (lsofPids.length) {
          killPids(lsofPids.map(Number).filter((n) => !isNaN(n)));
        } else if (lsofMissing && platform === "linux") {
          // Termux and other minimal Linux installs have no lsof: fall back
          // to the /proc scan instead of silently leaving the port held.
          killPids(findListenerPidsLinux(port));
        }
      }
    } catch { /* silent fail — continue anyway */ }

    // Wait for the port to be released, then resolve regardless.
    waitPortFree(port, 2000, { exec: execFn, platform });
    resolve();
  });
}

// Whether a process command line is a 9Router app process (CLI or
// next-server), for the startup cleanup in cli.js.
//
// BUG IT FIXES (found by the TUI/hide smoke test, 2026-11-12): the old
// inline check matched any line containing the substrings "node" +
// "9router" + "cli.js". A launcher whose argv merely *mentions* the CLI
// path — e.g. `python3 tui_driver.py ... lib/node_modules/9router-pro/cli/cli.js`
// ("node" matches inside "node_modules") — matched, so the CLI SIGKILLed
// its own launcher at startup. The same would kill a shell whose command
// line contains the path. The fix requires the *executable* to actually
// be node: the first token of the command (quote-aware, so
// `"C:\Program Files\nodejs\node.exe"` parses as one token) must be
// `node` (Unix) or `node.exe` (Windows), and only then do the path
// substrings count. The Windows WMI query already restricts to
// Name="node.exe", so this is defense-in-depth there; on Unix it is the
// only thing separating a real node process from a launcher mentioning
// the path.
function firstCommandToken(cmd) {
  const s = String(cmd || "").trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end === -1 ? s : s.slice(1, end);
  }
  return s.split(/\s+/)[0] || "";
}

function isAppProcessCommand(cmd, platform) {
  const lower = String(cmd || "").toLowerCase();
  const first = firstCommandToken(lower);
  const base = first.split(/[\\/]/).pop();
  const isNode = platform === "win32" ? base === "node.exe" : base === "node";
  if (!isNode) return false;
  return (lower.includes("9router") && (lower.includes("cli.js") || lower.includes("/9router") || lower.includes("\\9router")))
    || lower.includes("next-server");
}

// PIDs of 9Router app processes (CLI or next-server) parsed out of a
// process listing, for the startup cleanup in cli.js. `output` is `ps aux`
// on Unix or the WMI CSV (`"ProcessId","CommandLine"`) on Windows.
// `skipPids` is a Set of PID strings that must never be killed — the
// caller's own PID, plus the PID of the process that spawned this CLI
// (NINEROUTER_PARENT_PID): in the Hide-to-Tray flow the parent CLI is
// still alive while the detached tray child runs its startup cleanup,
// and without the exclusion the child SIGKILLed its own parent
// (hide-blocked smoke test, 2026-11-12: parent exited code=-9).
function collectAppPids(output, platform, skipPids) {
  const pids = [];
  const skip = skipPids instanceof Set ? skipPids : new Set();
  const lines = String(output || "").split("\n");
  if (platform === "win32") {
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cmdMatch = line.match(/^"\d+","(.*)"$/);
      const cmd = cmdMatch ? cmdMatch[1].replace(/""/g, '"') : line;
      if (!isAppProcessCommand(cmd, "win32")) continue;
      const pidMatch = line.match(/^"(\d+)"/);
      if (pidMatch && pidMatch[1] && !skip.has(pidMatch[1])) pids.push(pidMatch[1]);
    }
    return pids;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[1];
    if (!pid || isNaN(pid) || skip.has(pid)) continue;
    // COMMAND starts at the 11th whitespace field (ps aux: USER PID
    // %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND).
    const cmd = parts.slice(10).join(" ");
    if (isAppProcessCommand(cmd, "linux")) pids.push(pid);
  }
  return pids;
}

module.exports = {
  killProcessOnPort,
  findListenerPidsLinux,
  findListenerPidsWindows,
  parseNetstatListeningPids,
  isPortListeningWindows,
  waitPortFree,
  isPortListeningLinux,
  isAppProcessCommand,
  collectAppPids,
};
