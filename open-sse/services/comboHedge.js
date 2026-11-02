/**
 * Delayed-hedge race for combo member attempts (opt82).
 *
 * Pure helper: no combo imports, so it is unit-testable in isolation.
 * The caller passes starter functions that take an AbortSignal and return
 * a Response-like ({ ok, status }). The helper owns one AbortController
 * per attempt plus that attempt's budget timer.
 *
 * Semantics:
 * - The first member starts immediately. If it settles (ok or failed)
 *   before the hedge delay, the helper returns at once — fast failures
 *   stay sequential and never pay for a second attempt.
 * - If it is still pending at the hedge delay and a next member exists,
 *   the next member starts in parallel. The first ok wins; the loser is
 *   aborted before its body is consumed, so the slow case costs one extra
 *   connection, not a second full generation.
 * - A failure of one member while the other is still pending does not end
 *   the race: the pending member may still win. Only when every started
 *   member has failed does the helper return all-failed, driven by the
 *   last-settled failure.
 * - Client disconnect is detected, not guessed: a 499 (or AbortError)
 *   while NEITHER of our controllers is aborted means someone else — the
 *   client — went away. Everything is aborted at once and the helper
 *   reports clientAborted so the caller stops burning upstream attempts.
 * - A failure caused by our own budget timer is flagged timedOut so the
 *   caller can fail over with a 504 instead of a bare 499.
 */

function synthResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function raceWithHedge({ run, next, hedgeDelayMs = 0, budgetMs = 0 }) {
  const controllers = [];
  const timers = [];
  const failed = [];
  let clientAborted = false;

  const cleanup = () => {
    for (const t of timers) clearTimeout(t);
  };
  const abortAll = () => {
    for (const c of controllers) if (c) c.abort();
  };

  // "ok" | "failed" | "timeout" (our budget/hedge abort) | "client" (gone)
  const classify = (settlement) => {
    const controller = controllers[settlement.index];
    if (settlement.thrown) {
      if (settlement.thrown?.name === "AbortError") {
        return controller?.signal.aborted ? "timeout" : "client";
      }
      return "failed";
    }
    const result = settlement.result;
    if (result?.status === 499) {
      return controller?.signal.aborted ? "timeout" : "client";
    }
    if (result?.ok) return "ok";
    return "failed";
  };

  const toFailure = (settlement, kind) => {
    if (settlement.thrown) {
      if (kind === "timeout") return { index: settlement.index, result: synthResponse(499, "First response timed out"), timedOut: true };
      return { index: settlement.index, result: synthResponse(500, settlement.thrown?.message || "Upstream error"), timedOut: false };
    }
    return { index: settlement.index, result: settlement.result, timedOut: kind === "timeout" };
  };

  const pending = new Map();
  // Settlements arrive in true arrival order, even for attempts started
  // after the current wait began: each attempt pushes its settlement into
  // a queue the moment it lands, and the loop drains the queue in order.
  // (A naive Promise.race snapshot would process a late-started member's
  // early settlement AFTER the first member's late one — exactly backwards.)
  const queue = [];
  let notify = null;
  const pushSettlement = (s) => {
    queue.push(s);
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };
  const waitNext = async () => {
    while (queue.length === 0) {
      await new Promise((res) => {
        notify = res;
      });
    }
    return queue.shift();
  };

  const startAttempt = (index, fn) => {
    const controller = new AbortController();
    controllers[index] = controller;
    if (budgetMs > 0) timers.push(setTimeout(() => controller.abort(), budgetMs));
    const p = (async () => {
      try {
        const result = await fn(controller.signal);
        return { index, result, thrown: null };
      } catch (error) {
        return { index, result: null, thrown: error };
      }
    })();
    p.then((s) => pushSettlement(s));
    return p;
  };

  pending.set(0, startAttempt(0, run));
  let hedged = false;
  if (next && hedgeDelayMs > 0) {
    timers.push(setTimeout(() => {
      if (pending.size > 0 && !clientAborted) {
        hedged = true;
        pending.set(1, startAttempt(1, next));
      }
    }, hedgeDelayMs));
  }

  while (pending.size > 0) {
    const settlement = await waitNext();
    pending.delete(settlement.index);
    const kind = classify(settlement);

    if (kind === "client") {
      clientAborted = true;
      abortAll();
      // The caller is gone: do not wait for the drain, the started
      // attempts settle on their own (startAttempt never rejects).
      cleanup();
      return {
        winnerIndex: null,
        result: settlement.result ?? synthResponse(499, "Request aborted"),
        failed,
        drivingIndex: settlement.index,
        timedOut: false,
        clientAborted: true,
        hedged,
      };
    }

    if (kind === "ok") {
      abortAll();
      // The loser settles fast on abort, but an executor that ignores the
      // signal must not hold up the winner: bound the drain at 5s. The
      // loser's own budget timer still kills it in the background.
      await Promise.race([
        Promise.allSettled([...pending.values()]),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      cleanup();
      return {
        winnerIndex: settlement.index,
        result: settlement.result,
        failed,
        drivingIndex: settlement.index,
        timedOut: false,
        clientAborted: false,
        hedged,
      };
    }

    failed.push(toFailure(settlement, kind));
    // Pending empty = every started member failed. If the hedge timer has
    // not fired yet, this was a fast failure: return at once so the caller
    // advances sequentially instead of waiting out the hedge delay.
  }

  const driving = failed[failed.length - 1];
  cleanup();
  return {
    winnerIndex: null,
    result: driving ? driving.result : synthResponse(502, "Upstream error"),
    failed,
    drivingIndex: driving ? driving.index : 0,
    timedOut: driving ? driving.timedOut : false,
    clientAborted: false,
    hedged,
  };
}
