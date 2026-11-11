// Kill whatever listens on a TCP port, without assuming lsof exists.
//
// The launcher frees the app port at startup before spawning its own server.
// The old implementation used only `lsof -ti:<port>`; on Termux lsof is
// usually absent, so the call threw and the port was silently left held —
// an orphaned next-server child then kept the port and the new server died
// with EADDRINUSE while the CLI printed "running".
//
// Order: lsof first (fast, works wherever it exists), then a pure-Node
// /proc fallback on Linux (reads /proc/net/tcp{,6} for LISTEN sockets on the
// port, maps socket inodes to PIDs via /proc/<pid>/fd). No external tool
// besides lsof is required anywhere in this file.
const { execSync } = require("child_process");
const fs = require("fs");

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function isLsofMissingError(err) {
  const msg = String((err && err.message) || err || "");
  return err && (err.code === "ENOENT" || err.status === 127 || /not found/i.test(msg) || /ENOENT/.test(msg));
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
// event loop while it waits. Non-Linux falls back to the old fixed sleep.
function waitPortFree(port, timeoutMs = 2000) {
  if (process.platform !== "linux") { sleepSync(500); return false; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPortListeningLinux(port)) return true;
    sleepSync(100);
  }
  return !isPortListeningLinux(port);
}

// Kill any process on a specific port. Resolves when the port is free or
// the wait expires — never throws, so startup is never blocked by cleanup.
function killProcessOnPort(port) {
  return new Promise((resolve) => {
    try {
      const platform = process.platform;

      if (platform === "win32") {
        try {
          const output = execSync(`netstat -ano | findstr :${port}`, {
            encoding: "utf8",
            shell: true,
            windowsHide: true,
            timeout: 5000,
          }).trim();
          const lines = output.split("\n").filter((l) => l.includes("LISTENING"));
          for (const line of lines) {
            const pid = line.trim().split(/\s+/).pop();
            if (pid && !isNaN(pid)) {
              try { execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 }); } catch { /* ignore */ }
            }
          }
        } catch { /* port is free or error */ }
      } else {
        // macOS/Linux: lsof first.
        let lsofPids = null;
        let lsofMissing = false;
        try {
          const pidOutput = execSync(`lsof -ti:${port}`, {
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
    waitPortFree(port, 2000);
    resolve();
  });
}

module.exports = { killProcessOnPort, findListenerPidsLinux, waitPortFree, isPortListeningLinux };
