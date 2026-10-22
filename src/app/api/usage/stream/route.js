import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// The client merges only activeRequests / recentRequests / errorProvider /
// pending from SSE messages, so "update" and "pending" events push just
// those fields (built from getActiveRequests, no stats recompute). The full
// stats object is sent once on connect and refreshed on a slow interval.
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, refresh: null, cachedStats: null, cleanup: null };

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      state.cleanup = () => {
        if (state.closed) return;
        state.closed = true;
        statsEmitter.off("update", sendLight);
        statsEmitter.off("pending", sendLight);
        clearInterval(state.keepalive);
        clearInterval(state.refresh);
      };

      const sendFull = async () => {
        if (state.closed) return;
        try {
          state.cachedStats = await getUsageStats();
          enqueue(state.cachedStats);
        } catch {
          state.cleanup();
        }
      };

      const sendLight = async () => {
        if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          enqueue({ activeRequests, recentRequests, errorProvider, pending: state.cachedStats.pending });
        } catch {
          state.cleanup();
        }
      };

      await sendFull();

      statsEmitter.on("update", sendLight);
      statsEmitter.on("pending", sendLight);

      state.refresh = setInterval(sendFull, 60000);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.cleanup();
        }
      }, 25000);
    },

    cancel() {
      state.cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
