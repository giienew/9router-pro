// Bulk-add API-key planner.
//
// Background: the backend upserts apikey connections BY NAME
// (src/lib/db/repos/connectionsRepo.js ~L144: existing = all.find(c =>
// c.authType === "apikey" && c.name === data.name)). A colliding name
// overwrites an existing key instead of inserting a new one. Bulk-add used to
// derive "<base> <lineIndex>" from the paste position, blind to existing
// names, so re-adding keys often silently replaced earlier ones.
//
// This planner gap-fills the smallest free "<base> <n>" against both existing
// connection names and names already assigned earlier in the same batch, so a
// generated name is never reused and the backend always inserts.
//
// ponytail: only numeric-suffix collision is handled. A user who manually
// types an exact existing non-numbered custom name (no index) will still hit
// the backend upsert — but bulk auto-naming always appends " <n>", so this
// path is unreachable from the bulk modal. Upgrade path: a backend
// "skip-if-exists" flag on POST /api/providers if single-add ever needs it.

/**
 * Parse one pipe-separated bulk line into { baseName, apiKey, providerSpecificData? }.
 * @param {string} line
 * @param {{isCloudflareAi?: boolean}} [opts]
 * @returns {{baseName: string, apiKey: string, providerSpecificData?: object}|null}
 */
function parseLine(line, opts = {}) {
  const { isCloudflareAi = false } = opts;
  // Muse keys are full "LLM|id|secret" strings: keep them opaque instead
  // of splitting on the first pipe (which used to shred the key into a
  // bogus name + truncated secret). planBulkAdd auto-names them LLM 1, 2, …
  if (!isCloudflareAi && /^LLM\|/i.test(line.trim())) {
    return { baseName: "LLM", apiKey: line.trim() };
  }
  const parts = line.split("|");

  if (isCloudflareAi && parts.length >= 3) {
    // name|apiKey|accountId  (apiKey may itself contain pipes)
    const baseName = parts[0].trim();
    const apiKey = parts.slice(1, -1).join("|").trim();
    const accountId = parts[parts.length - 1].trim();
    return {
      baseName: baseName || "Key",
      apiKey,
      providerSpecificData: { accountId },
    };
  }

  if (parts.length >= 2) {
    // name|apiKey  (apiKey may itself contain pipes)
    const baseName = parts[0].trim();
    const apiKey = parts.slice(1).join("|").trim();
    return { baseName: baseName || "Key", apiKey };
  }

  // apiKey only — auto-named "Key N"
  const apiKey = parts[0].trim();
  return { baseName: "Key", apiKey };
}

/**
 * Plan a bulk add: parse lines, assign collision-free "<base> <n>" names.
 *
 * @param {string[]} lines raw paste lines
 * @param {string[]|null|undefined} existingNames connection names already saved
 * @param {{isCloudflareAi?: boolean}} [opts]
 * @returns {{name: string, apiKey: string, skipped: boolean, providerSpecificData?: object}[]}
 */
export function planBulkAdd(lines, existingNames, opts = {}) {
  const { isCloudflareAi = false } = opts;

  const safeExisting = Array.isArray(existingNames) ? existingNames : [];
  const used = new Set(safeExisting.map((n) => (typeof n === "string" ? n.toLowerCase() : "")));

  const out = [];
  for (const raw of lines) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) continue;

    const parsed = parseLine(line, { isCloudflareAi });
    if (!parsed || !parsed.apiKey) continue;

    const base = parsed.baseName;

    // Gap-fill from 1: smallest free "<base> <n>" not in `used`.
    // O(batch * existing) — fine for bulk add (tens to low hundreds of keys).
    let idx = 1;
    let name;
    for (;;) {
      name = `${base} ${idx}`;
      if (!used.has(name.toLowerCase())) break;
      idx += 1;
    }
    used.add(name.toLowerCase());

    const entry = { name, apiKey: parsed.apiKey, skipped: false };
    if (parsed.providerSpecificData) entry.providerSpecificData = parsed.providerSpecificData;
    out.push(entry);
  }
  return out;
}

/**
 * Run a bulk batch through a per-entry worker with bounded concurrency.
 *
 * Background: the bulk modal used to await each entry fully (validate, then
 * save) before starting the next one, so a batch of N keys cost N sequential
 * upstream round trips. Browsers also cap same-origin connections (~6), so a
 * pool larger than that buys nothing — 6 workers is the sweet spot: the same
 * validate+save work per key, but overlapped instead of queued.
 *
 * Names in `entries` must already be unique (see planBulkAdd) — that is what
 * makes parallel inserts safe against the backend's upsert-by-name.
 *
 * @param {object[]} entries plan entries (see planBulkAdd)
 * @param {(entry: object) => Promise<boolean>} worker resolves true on success
 * @param {{concurrency?: number, onProgress?: (p: {done: number, total: number, current: string, success: number, failed: number}) => void}} [opts]
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function runBulkPool(entries, worker, opts = {}) {
  const { concurrency = 6, onProgress = null } = opts;
  const total = entries.length;
  let success = 0;
  let failed = 0;
  let done = 0;
  let next = 0;
  // Index claim happens synchronously before the first await of each
  // iteration, so no two workers ever grab the same entry.
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, total)) },
    async () => {
      while (next < total) {
        const entry = entries[next++];
        let ok = false;
        try {
          ok = (await worker(entry)) === true;
        } catch {
          ok = false;
        }
        if (ok) success++;
        else failed++;
        done++;
        if (onProgress) onProgress({ done, total, current: entry.name, success, failed });
      }
    },
  );
  await Promise.all(runners);
  return { success, failed };
}
