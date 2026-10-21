// Stop flags for running batch provider tests, keyed by a client-supplied
// jobId. The batch route registers its jobId and polls the flag between
// connections; the stop route flips it. In-memory only — a restart simply
// forgets running jobs.
const g = globalThis;
if (!g.__batchTestJobs) g.__batchTestJobs = new Map();
const jobs = g.__batchTestJobs;

export function registerBatchJob(id) {
  jobs.set(id, { stopped: false, at: Date.now() });
}

export function stopBatchJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopped = true;
  return true;
}

export function isBatchStopped(id) {
  return !!jobs.get(id)?.stopped;
}

export function clearBatchJob(id) {
  jobs.delete(id);
}
