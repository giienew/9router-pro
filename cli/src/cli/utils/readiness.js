// Server-readiness probe for the CLI launcher (cli/cli.js).
//
// waitServerReady polls the server until it answers an HTTP request or the
// timeout expires. Its boolean result is the launcher's only proof the
// server is up — callers MUST branch on it. Never print "running" when it
// resolves false: that exact mistake made users open a dead dashboard and
// see "This page couldn't load" while the terminal claimed the router was
// running (Pro issue #1, 2026-11-10).
//
// The probe is HTTP, not a bare TCP connect: a TCP accept only proves
// something listens, and a stale listener (a dummy process, an orphaned
// next-server, another app on the port) accepts TCP while serving nothing.
// GET /api/health answers only when OUR server is up — it is public (no
// auth) and any HTTP status counts, because even a degraded server that
// answers HTTP will still serve the dashboard shell.
const http = require("http");

const DEFAULT_READY_TIMEOUT_MS = 15000;

// Poll until the server answers GET /api/health, or timeout — avoids blind fixed waits.
function waitServerReady(port, { timeoutMs = DEFAULT_READY_TIMEOUT_MS, intervalMs = 150, attemptTimeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const scheduleRetry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tryProbe, intervalMs);
    };
    const tryProbe = () => {
      // One retry per attempt: the timeout handler destroys the request,
      // which then also emits "error" — without this guard each attempt
      // would schedule two retries and fan out exponentially against a
      // hung server.
      let handled = false;
      const once = () => { if (handled) return; handled = true; scheduleRetry(); };
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: attemptTimeoutMs },
        (res) => {
          // Headers received = our server is alive and answering. Drain
          // the body and resolve; a stalled body must not block the probe.
          res.resume();
          resolve(true);
        },
      );
      req.on("timeout", () => { req.destroy(); once(); });
      req.on("error", once);
    };
    tryProbe();
  });
}

// Lines to print (to stderr) when the server did not come up within the
// readiness window. Names the port, the wait, and the next steps — never a
// bare "failed to start", so a user on a phone can act on it without
// guessing.
function serverNotReadyLines(port, { timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
  return [
    "",
    `❌ Server did not start on port ${port} within ${Math.round(timeoutMs / 1000)}s.`,
    "   The dashboard will not load (connection refused) — the router is NOT running.",
    "   Diagnose it with:",
    `     9router-pro doctor --port ${port}`,
    "   Then check the server log and free the port if something stale holds it:",
    `     fuser -k ${port}/tcp`,
    "",
  ];
}

module.exports = { waitServerReady, serverNotReadyLines, DEFAULT_READY_TIMEOUT_MS };
