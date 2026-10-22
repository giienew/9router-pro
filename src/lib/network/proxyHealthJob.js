import { getProxyPools, updateProxyPool } from "@/lib/db/repos/proxyPoolsRepo";
import { testProxyUrl, testRelayUrl } from "@/lib/network/proxyTest";

// Server-side bulk proxy health check. The dashboard used to test pools one
// HTTP request per pool from the browser, which falls apart at thousands of
// pools; this job runs in-process with bounded concurrency and the page just
// polls its progress. State lives on globalThis so module reloads share it.
const RELAY_TYPES = ["vercel", "cloudflare", "deno", "netlify"];
const CONCURRENCY = 40;

function freshState() {
  return { running: false, total: 0, done: 0, passed: 0, failed: 0, startedAt: null, finishedAt: null };
}

if (!globalThis.__proxyHealthJob) globalThis.__proxyHealthJob = freshState();
const job = globalThis.__proxyHealthJob;

export function getProxyHealthJobState() {
  return { ...job };
}

export async function startProxyHealthJob(ids) {
  if (job.running) return { ...job };
  const all = await getProxyPools();
  const targets = Array.isArray(ids) && ids.length ? all.filter((p) => ids.includes(p.id)) : all;
  Object.assign(job, freshState(), {
    running: true,
    total: targets.length,
    startedAt: new Date().toISOString(),
  });

  const queue = [...targets];
  const worker = async () => {
    while (queue.length > 0) {
      const pool = queue.shift();
      if (!pool) break;
      const result = RELAY_TYPES.includes(pool.type)
        ? await testRelayUrl(pool.proxyUrl)
        : await testProxyUrl({ proxyUrl: pool.proxyUrl });
      try {
        await updateProxyPool(pool.id, {
          testStatus: result.ok ? "active" : "error",
          lastTestedAt: new Date().toISOString(),
          lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
          isActive: result.ok,
        });
      } catch {
        // a failed write must not stall the job; the counters still move
      }
      job.done += 1;
      if (result.ok) job.passed += 1; else job.failed += 1;
    }
  };

  (async () => {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(targets.length, 1)) }, worker));
    job.running = false;
    job.finishedAt = new Date().toISOString();
  })();

  return { ...job };
}
