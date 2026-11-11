// CLI readiness: the launcher must never claim "running" when the server
// is not up (Pro issue #1 — "This page couldn't load" while the terminal
// said the router was running). Covers the extracted modules:
//   cli/src/cli/utils/readiness.js (waitServerReady + failure message)
//   cli/src/cli/utils/restartBudget.js (bounded crash loop)
//   cli/src/cli/utils/portCleanup.js (lsof-first kill, /proc fallback)
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { waitServerReady, serverNotReadyLines } = require("../../cli/src/cli/utils/readiness.js");
const { createRestartBudget } = require("../../cli/src/cli/utils/restartBudget.js");
const { killProcessOnPort, findListenerPidsLinux, waitPortFree, isPortListeningLinux } = require("../../cli/src/cli/utils/portCleanup.js");

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
