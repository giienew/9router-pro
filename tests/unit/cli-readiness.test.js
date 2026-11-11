// CLI readiness: the launcher must never claim "running" when the server
// is not up (Pro issue #1 — "This page couldn't load" while the terminal
// said the router was running). Covers the extracted modules:
//   cli/src/cli/utils/readiness.js (waitServerReady + failure message,
//     incl. platform-aware port-free hints — Windows has no fuser)
//   cli/src/cli/utils/restartBudget.js (bounded crash loop)
//   cli/src/cli/utils/portCleanup.js (lsof-first kill, /proc fallback,
//     Windows netstat + taskkill, isAppProcessCommand whitelist)
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { waitServerReady, serverNotReadyLines, portFreeHintLines } = require("../../cli/src/cli/utils/readiness.js");
const { createRestartBudget } = require("../../cli/src/cli/utils/restartBudget.js");
const { killProcessOnPort, findListenerPidsLinux, findListenerPidsWindows, parseNetstatListeningPids, isPortListeningWindows, waitPortFree, isPortListeningLinux, isAppProcessCommand, collectAppPids } = require("../../cli/src/cli/utils/portCleanup.js");

// --- helpers ---------------------------------------------------------------

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function connectRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => { socket.destroy(); resolve(true); });
  });
}

async function poll(fn, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Spawn a separate process that just listens on the port (so the /proc scan
// sees a foreign PID — it deliberately excludes the test process itself).
function spawnListener(port) {
  const child = spawn(process.execPath, ["-e",
    `require("net").createServer().listen(${port}, "127.0.0.1", () => setInterval(() => {}, 60000));`,
  ], { stdio: "ignore", detached: true });
  child.unref();
  return child;
}

const children = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
  }
});

// --- waitServerReady -------------------------------------------------------

describe("waitServerReady", () => {
  it("resolves true when the port answers HTTP", async () => {
    const port = await ephemeralPort();
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(waitServerReady(port, { timeoutMs: 3000 })).resolves.toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("resolves true on any HTTP status (a degraded server still serves)", async () => {
    const port = await ephemeralPort();
    const server = http.createServer((_req, res) => { res.writeHead(503); res.end("{}"); });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(waitServerReady(port, { timeoutMs: 3000 })).resolves.toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("resolves false when nothing listens (the result callers must check)", async () => {
    const port = await ephemeralPort();
    await expect(waitServerReady(port, { timeoutMs: 300 })).resolves.toBe(false);
  });

  it("resolves false for a bare TCP listener that never speaks HTTP (stale dummy on the port)", async () => {
    const port = await ephemeralPort();
    // Track accepted sockets: the dummy never reads them, so they never
    // end on their own — destroy them or close() hangs forever.
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(waitServerReady(port, { timeoutMs: 800, attemptTimeoutMs: 150 })).resolves.toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("serverNotReadyLines", () => {
  it("names the port, the wait, and the next steps", () => {
    const text = serverNotReadyLines(20127, { timeoutMs: 15000 }).join("\n");
    expect(text).toContain("20127");
    expect(text).toContain("15s");
    expect(text).toContain("doctor --port 20127");
    expect(text).toContain("fuser -k 20127/tcp");
    expect(text).toContain("NOT running");
    // And it must never contain the word that caused the complaint.
    expect(text).not.toMatch(/now running/i);
  });

  it("on Windows suggests netstat + taskkill, never fuser (the original complainer was on Windows)", () => {
    const text = serverNotReadyLines(20127, { timeoutMs: 15000, platform: "win32" }).join("\n");
    expect(text).toContain("20127");
    expect(text).toContain("doctor --port 20127");
    expect(text).toContain("netstat -ano | findstr :20127");
    expect(text).toContain("taskkill /PID <pid> /F");
    expect(text).toContain("NOT running");
    expect(text).not.toContain("fuser");
    expect(text).not.toMatch(/now running/i);
  });
});

describe("portFreeHintLines", () => {
  it("returns fuser on Linux and macOS", () => {
    expect(portFreeHintLines(20127, "linux").join("\n")).toContain("fuser -k 20127/tcp");
    expect(portFreeHintLines(20127, "darwin").join("\n")).toContain("fuser -k 20127/tcp");
  });

  it("returns netstat + taskkill on Windows", () => {
    const lines = portFreeHintLines(20127, "win32");
    expect(lines.join("\n")).toContain("netstat -ano | findstr :20127");
    expect(lines.join("\n")).toContain("taskkill /PID <pid> /F");
  });
});

// --- Windows netstat parsing + cleanup (injected fake exec: no Windows box here) ---

const NETSTAT_SAMPLE = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:20127          0.0.0.0:0              LISTENING       1234",
  "  TCP    [::]:20127             [::]:0                 LISTENING       5678",
  "  TCP    127.0.0.1:20127        127.0.0.1:54321        ESTABLISHED     9999",
  "  TCP    127.0.0.1:54321        127.0.0.1:20127        ESTABLISHED     8888",
  "  TCP    0.0.0.0:2012           0.0.0.0:0              LISTENING       7777",
  "  TCP    0.0.0.0:20127          0.0.0.0:0              LISTENING       1234",
  "  UDP    0.0.0.0:20127          *:*                                    5555",
  "",
].join("\n");

describe("parseNetstatListeningPids", () => {
  it("returns exactly the LISTENING PIDs for the target port", () => {
    // IPv4 + IPv6 listeners, same PID twice (deduped); an ESTABLISHED
    // connection on :20127, one TO :20127, a listener on :2012 (prefix
    // confusion), and a UDP line must all be excluded.
    expect(parseNetstatListeningPids(NETSTAT_SAMPLE, 20127).sort((a, b) => a - b)).toEqual([1234, 5678]);
    expect(parseNetstatListeningPids(NETSTAT_SAMPLE, 2012)).toEqual([7777]);
    expect(parseNetstatListeningPids(NETSTAT_SAMPLE, 9999)).toEqual([]);
    expect(parseNetstatListeningPids("", 20127)).toEqual([]);
  });
});

describe("isAppProcessCommand", () => {
  // The startup cleanup must kill real 9Router node processes (CLI,
  // orphaned next-server/custom-server) and NOTHING else. Regression:
  // the old substring check killed the PTY driver that launched the CLI
  // in the TUI/hide smoke test (2026-11-12) because the driver's argv
  // mentioned the CLI path (.../node_modules/9router-pro/cli/cli.js —
  // "node" matched inside "node_modules").
  it("matches a real node CLI / next-server / custom-server process", () => {
    expect(isAppProcessCommand("node /home/x/lib/node_modules/9router-pro/cli/cli.js --tray --port 20127", "linux")).toBe(true);
    expect(isAppProcessCommand("/usr/bin/node /home/x/9router-pro/.next/standalone/server.js", "linux")).toBe(true);
    expect(isAppProcessCommand("node /home/x/9router-pro/.next/standalone/custom-server.js", "linux")).toBe(true);
    expect(isAppProcessCommand("node /home/x/.next/server/next-server", "linux")).toBe(true);
    expect(isAppProcessCommand("node /home/x/9router-pro/cli/cli.js --port 20199", "darwin")).toBe(true);
  });

  it("matches the Windows node.exe form, incl. a quoted Program Files path", () => {
    expect(isAppProcessCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Administrator\\9router-pro\\cli\\cli.js --tray', "win32")).toBe(true);
    expect(isAppProcessCommand("node.exe C:\\Users\\Administrator\\9router-pro\\cli\\cli.js", "win32")).toBe(true);
    expect(isAppProcessCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\next-server', "win32")).toBe(true);
  });

  it("never matches a launcher whose argv merely mentions the CLI path", () => {
    // The exact regression: PTY driver + shell that launched the CLI.
    expect(isAppProcessCommand("python3 /home/x/tui_driver.py tui-healthy /home/x/logs/tui-healthy.log 20199 /home/x/lib/node_modules/9router-pro/cli/cli.js /home/x/home /home/x/data", "linux")).toBe(false);
    expect(isAppProcessCommand("/bin/bash -c node /home/x/lib/node_modules/9router-pro/cli/cli.js --tray --port 20199", "linux")).toBe(false);
    expect(isAppProcessCommand("python.exe C:\\x\\9router-pro\\cli\\cli.js", "win32")).toBe(false);
    expect(isAppProcessCommand("grep 9router-pro/cli/cli.js", "linux")).toBe(false);
    expect(isAppProcessCommand("cursor /home/x/9router-pro/cli/cli.js", "linux")).toBe(false);
  });

  it("does not match unrelated node processes or empty input", () => {
    expect(isAppProcessCommand("node /home/x/other-app/server.js", "linux")).toBe(false);
    expect(isAppProcessCommand("node /home/x/cli.js", "linux")).toBe(false); // cli.js, but not a 9router path
    expect(isAppProcessCommand("", "linux")).toBe(false);
    expect(isAppProcessCommand("node /home/x/9router-pro/cli/cli.js", "win32")).toBe(false); // Unix node binary on Windows
  });
});

describe("collectAppPids", () => {
  // ps aux sample: header, the Hide parent CLI (1111), the tray child
  // (2222), the PTY driver that launched the CLI (3333), an orphaned
  // next-server (4444), and a grep for the path (5555).
  const PS_SAMPLE = [
    "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "hatch       1111  0.0  0.1  123456  7890 ?        Sl   17:19   0:00 node /home/x/lib/node_modules/9router-pro/cli/cli.js --port 20199",
    "hatch       2222  0.0  0.1  123456  7890 ?        Sl   17:19   0:00 node /home/x/lib/node_modules/9router-pro/cli/cli.js --tray --skip-update -p 20199",
    "hatch       3333  0.0  0.1  123456  7890 ?        Sl   17:19   0:00 python3 /home/x/tui_driver.py hide-blocked /home/x/logs/hide-blocked.log 20199 /home/x/lib/node_modules/9router-pro/cli/cli.js /home/x/home /home/x/data",
    "hatch       4444  0.0  0.1  123456  7890 ?        Sl   17:19   0:00 node /home/x/9router-pro/.next/server/next-server",
    "hatch       5555  0.0  0.1  123456  7890 ?        R    17:19   0:00 grep 9router-pro/cli/cli.js",
    "",
  ].join("\n");

  it("kills the tray child and the orphaned next-server, never the launcher or the parent", () => {
    // The tray child (2222) runs this with skipPids = {self, parent 1111}:
    // it must kill the orphaned next-server (4444) but NOT its parent (1111),
    // NOT the python driver (3333), NOT the grep (5555).
    expect(collectAppPids(PS_SAMPLE, "linux", new Set(["2222", "1111"]))).toEqual(["4444"]);
    // Without the parent exclusion (plain startup scan, self=2222): the
    // parent CLI (1111) is a legitimate target, plus the next-server.
    expect(collectAppPids(PS_SAMPLE, "linux", new Set(["2222"]))).toEqual(["1111", "4444"]);
    // Empty skip set: self is not excluded by this helper (cli.js adds it).
    expect(collectAppPids(PS_SAMPLE, "linux", new Set())).toEqual(["1111", "2222", "4444"]);
    expect(collectAppPids("", "linux", new Set())).toEqual([]);
  });

  it("does the same on the Windows WMI CSV form", () => {
    const WMI_SAMPLE = [
      '"ProcessId","CommandLine"',
      '"1111","""C:\\Program Files\\nodejs\\node.exe"" C:\\Users\\Administrator\\9router-pro\\cli\\cli.js --port 20199"',
      '"2222","""C:\\Program Files\\nodejs\\node.exe"" C:\\Users\\Administrator\\9router-pro\\cli\\cli.js --tray --skip-update -p 20199"',
      '"3333","python.exe C:\\x\\9router-pro\\cli\\cli.js"',
      '"4444","""C:\\Program Files\\nodejs\\node.exe"" C:\\x\\next-server"',
      "",
    ].join("\n");
    expect(collectAppPids(WMI_SAMPLE, "win32", new Set(["2222", "1111"]))).toEqual(["4444"]);
    expect(collectAppPids(WMI_SAMPLE, "win32", new Set(["2222"]))).toEqual(["1111", "4444"]);
  });
});

describe("isPortListeningWindows", () => {
  it("is true only when a LISTENING line for the port exists", () => {
    const fakeExec = () => NETSTAT_SAMPLE;
    expect(isPortListeningWindows(20127, fakeExec)).toBe(true);
    expect(isPortListeningWindows(2012, fakeExec)).toBe(true);
    expect(isPortListeningWindows(9999, fakeExec)).toBe(false);
    expect(isPortListeningWindows(20127, () => "")).toBe(false);
    expect(isPortListeningWindows(20127, () => { throw new Error("netstat failed"); })).toBe(false);
  });
});

describe("killProcessOnPort (win32, injected exec)", () => {
  it("taskkills the LISTENING PIDs and verifies the port freed", async () => {
    const calls = [];
    let netstatCalls = 0;
    const fakeExec = (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("netstat")) {
        // First netstat (cleanup scan): listener present. Later ones
        // (waitPortFree polling): the kill worked, port is free.
        netstatCalls += 1;
        return netstatCalls === 1 ? NETSTAT_SAMPLE : "";
      }
      if (cmd.startsWith("taskkill")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };
    await killProcessOnPort(20127, { exec: fakeExec, platform: "win32" });
    expect(calls).toContain("taskkill /F /PID 1234");
    expect(calls).toContain("taskkill /F /PID 5678");
    expect(calls.filter((c) => c.startsWith("taskkill"))).toHaveLength(2);
    expect(netstatCalls).toBeGreaterThan(1); // waitPortFree actually re-checked
  });

  it("resolves quietly when netstat fails (port free or netstat missing)", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      throw new Error("netstat failed");
    };
    await expect(killProcessOnPort(20127, { exec: fakeExec, platform: "win32" })).resolves.toBeUndefined();
    expect(calls.filter((c) => c.startsWith("taskkill"))).toHaveLength(0);
  });

  it("resolves quietly when nothing listens", async () => {
    const calls = [];
    const fakeExec = (cmd) => {
      calls.push(cmd);
      return "";
    };
    await expect(killProcessOnPort(20127, { exec: fakeExec, platform: "win32" })).resolves.toBeUndefined();
    expect(calls.filter((c) => c.startsWith("taskkill"))).toHaveLength(0);
  });
});

describe("findListenerPidsWindows", () => {
  it("returns the parsed PIDs, [] when netstat fails", () => {
    expect(findListenerPidsWindows(20127, () => NETSTAT_SAMPLE).sort((a, b) => a - b)).toEqual([1234, 5678]);
    expect(findListenerPidsWindows(20127, () => { throw new Error("no netstat"); })).toEqual([]);
  });
});

// --- restartBudget ---------------------------------------------------------

describe("createRestartBudget", () => {
  it("restarts twice, then MITM-resets once, then reaches terminal", () => {
    const budget = createRestartBudget({ maxRestarts: 2, resetMs: 30000 });
    expect(budget.recordCrash(100)).toEqual({ action: "restart", delayMs: 1000, attempt: 1 });
    expect(budget.recordCrash(100)).toEqual({ action: "restart", delayMs: 2000, attempt: 2 });
    expect(budget.recordCrash(100)).toEqual({ action: "mitm-reset" });
    expect(budget.recordCrash(100)).toEqual({ action: "restart", delayMs: 1000, attempt: 1 });
    expect(budget.recordCrash(100)).toEqual({ action: "restart", delayMs: 2000, attempt: 2 });
    expect(budget.recordCrash(100)).toEqual({ action: "terminal" });
    // Terminal is sticky: further crashes stay terminal.
    expect(budget.recordCrash(100)).toEqual({ action: "terminal" });
  });

  it("resets the counter after a stable run", () => {
    const budget = createRestartBudget({ maxRestarts: 2, resetMs: 30000 });
    expect(budget.recordCrash(100).action).toBe("restart");
    expect(budget.recordCrash(100).action).toBe("restart");
    // A 30s+ stable run resets the counter before the next crash.
    expect(budget.recordCrash(30000)).toEqual({ action: "restart", delayMs: 1000, attempt: 1 });
  });
});

// --- portCleanup -----------------------------------------------------------

describe("findListenerPidsLinux + isPortListeningLinux", () => {
  it("finds a foreign listener PID and reports the port busy, then free", async () => {
    const port = await ephemeralPort();
    expect(isPortListeningLinux(port)).toBe(false);
    const child = spawnListener(port);
    children.push(child);
    expect(await poll(() => isPortListeningLinux(port))).toBe(true);
    const pids = findListenerPidsLinux(port);
    expect(pids).toContain(child.pid);
  });
});

describe("killProcessOnPort", () => {
  it("kills the listener via lsof when lsof exists", async () => {
    const port = await ephemeralPort();
    const child = spawnListener(port);
    children.push(child);
    expect(await poll(() => isPortListeningLinux(port))).toBe(true);
    await killProcessOnPort(port);
    expect(await poll(() => connectRefused(port))).toBe(true);
    expect(isPortListeningLinux(port)).toBe(false);
  });

  it("kills the listener via the /proc fallback with lsof hidden from PATH", async () => {
    const port = await ephemeralPort();
    const child = spawnListener(port);
    children.push(child);
    expect(await poll(() => isPortListeningLinux(port))).toBe(true);
    const savedPath = process.env.PATH;
    try {
      // A PATH with no lsof (and no other tool the fallback needs — it is
      // pure fs + process.kill, so it must still work).
      process.env.PATH = "/tmp/cli-readiness-no-tools";
      await killProcessOnPort(port);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(await poll(() => connectRefused(port))).toBe(true);
    expect(isPortListeningLinux(port)).toBe(false);
  });

  it("resolves quietly when the port is already free", async () => {
    const port = await ephemeralPort();
    await expect(killProcessOnPort(port)).resolves.toBeUndefined();
  });

  it("asks lsof for LISTENING sockets only (never a client of the port)", async () => {
    const calls = [];
    const fakeExec = (cmd) => { calls.push(cmd); return ""; };
    const port = await ephemeralPort();
    await killProcessOnPort(port, { exec: fakeExec, platform: "linux" });
    expect(calls).toContain(`lsof -ti:${port} -sTCP:LISTEN`);
  });

  it("kills the listener but never a client connected to the port", async () => {
    // Regression: plain `lsof -ti:<port>` listed the Hide parent CLI too,
    // because its /api/health probe holds a client socket to the port —
    // the tray child SIGKILLed its own parent (hide-blocked, 2026-11-12).
    const port = await ephemeralPort();
    const listener = spawnListener(port);
    children.push(listener);
    expect(await poll(() => isPortListeningLinux(port))).toBe(true);
    const client = spawn(process.execPath, ["-e",
      `require("net").connect(${port}, "127.0.0.1", () => setInterval(() => {}, 60000));`,
    ], { stdio: "ignore", detached: true });
    client.unref();
    children.push(client);
    await new Promise((r) => setTimeout(r, 500)); // let the client connect
    await killProcessOnPort(port);
    expect(await poll(() => connectRefused(port))).toBe(true);
    expect(isPortListeningLinux(port)).toBe(false);
    const dead = (c) => { try { process.kill(c.pid, 0); return false; } catch { return true; } };
    expect(await poll(() => dead(listener))).toBe(true);
    expect(dead(client)).toBe(false); // the probe client survives
  });
});

describe("waitPortFree", () => {
  it("returns true immediately for a free port, false for a busy one", async () => {
    const port = await ephemeralPort();
    expect(waitPortFree(port, 500)).toBe(true);
    const child = spawnListener(port);
    children.push(child);
    expect(await poll(() => isPortListeningLinux(port))).toBe(true);
    expect(waitPortFree(port, 300)).toBe(false);
  });
});
