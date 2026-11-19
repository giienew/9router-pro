// Single shared API-key mask. usageRepo, webhookEvents, and the dashboard
// preset UI all render masked keys, and they must agree: short keys show
// first char + ***, long keys show first 8 + *** + last 4. Never the full
// key. Pure (no Node imports) so server and client components can share it.
//
// Audit item 3: apiKeys.key is now stored HASHED at rest as
// `sha256:<prefix>:<last4>:<hex>`. The masker understands that format and
// renders `********<last4>` from the embedded hint — the digest itself is
// never shown (it would be useless as a display value and must not leak
// into UI state, logs, or copy buffers).
export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const t = key.trim();
  if (t.startsWith("sha256:")) {
    const parts = t.slice("sha256:".length).split(":");
    const last4 = parts.length === 3 ? parts[1] : null;
    return last4 ? `********${last4}` : "********";
  }
  if (t.length <= 12) return `${t.charAt(0)}***`;
  return `${t.slice(0, 8)}***${t.slice(-4)}`;
}

/** Last 4 of a stored key value, hashed (`sha256:...`) or legacy plaintext. */
export function last4OfApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const t = key.trim();
  if (!t) return null;
  if (t.startsWith("sha256:")) {
    const parts = t.slice("sha256:".length).split(":");
    return parts.length === 3 && parts[1] ? parts[1] : null;
  }
  return t.slice(-4);
}

/**
 * Strip a key record for API responses (audit item 3): the stored value —
 * hashed or legacy plaintext — NEVER leaves the server on a read. Returns a
 * copy with `key` removed and only `keyMasked` / `last4` in its place.
 * Quota, limits, access, and all other fields pass through untouched.
 */
export function toMaskedApiKeyRecord(record) {
  if (!record || typeof record !== "object") return record;
  const { key, ...rest } = record;
  return { ...rest, keyMasked: maskApiKey(key), last4: last4OfApiKey(key) };
}
