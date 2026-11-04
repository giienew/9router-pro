// Single shared API-key mask. usageRepo, webhookEvents, and the dashboard
// preset UI all render masked keys, and they must agree: short keys show
// first char + ***, long keys show first 8 + *** + last 4. Never the full
// key. Pure (no Node imports) so server and client components can share it.
export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const t = key.trim();
  if (t.length <= 12) return `${t.charAt(0)}***`;
  return `${t.slice(0, 8)}***${t.slice(-4)}`;
}
