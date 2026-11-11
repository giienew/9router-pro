// Restart budget for the CLI launcher's server child (cli/cli.js).
//
// The old loop respawned a crashing server forever: after MAX_RESTARTS it
// disabled MITM, reset the counter, and started over — so a permanently
// crashing server (bad bind, EADDRINUSE, OOM) left the CLI alive printing
// "running" while nothing served. This state machine bounds the loop: one
// MITM-disable reset per process lifetime, then a terminal state. The
// launcher prints the last failure plainly and exits instead of looping
// silently.
//
// Pure state, no I/O: the MITM-disable side effect and the respawn stay in
// cli.js, driven by the returned action.
function createRestartBudget({ maxRestarts = 2, resetMs = 30000 } = {}) {
  let restartCount = 0;
  let mitmResetUsed = false;

  return {
    // Record one server exit. aliveMs is how long that run lived.
    // Returns { action: "restart", delayMs, attempt } |
    //         { action: "mitm-reset" } | { action: "terminal" }.
    recordCrash(aliveMs) {
      // A run that stayed alive long enough resets the counter — it was a
      // stable server that later died, not a crash loop.
      if (aliveMs >= resetMs) restartCount = 0;

      if (restartCount >= maxRestarts) {
        if (!mitmResetUsed) {
          mitmResetUsed = true;
          restartCount = 0;
          return { action: "mitm-reset" };
        }
        return { action: "terminal" };
      }

      restartCount++;
      return {
        action: "restart",
        delayMs: Math.min(1000 * restartCount, 10000),
        attempt: restartCount,
      };
    },
    get state() {
      return { restartCount, mitmResetUsed };
    },
  };
}

module.exports = { createRestartBudget };
