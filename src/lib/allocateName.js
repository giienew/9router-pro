// Server-side bulk name allocation helper (opt21) — pure, no dependencies.
//
// Smallest free "<base> <n>" name for a base, given the existing names.
// Comparison is case-insensitive (the DB conflict check in
// createProviderConnection is exact-match, so a case-insensitively free
// name can never collide exactly). The scan is unbounded: it walks N
// upward until free, so a fully-taken front range (e.g. Key 1..Key 28844)
// yields Key 28845, Key 28846, ... — any count, any provider. Callers
// that insert must still handle a race 409 (two concurrent allocators)
// by re-scanning; this helper alone never touches the DB.
export function allocateFreeName(base, takenNames) {
  const clean = typeof base === "string" ? base.trim() : "";
  const prefix = clean || "Key";
  const taken = new Set();
  if (takenNames) {
    for (const name of takenNames) {
      if (typeof name === "string") taken.add(name.toLowerCase());
    }
  }
  let n = 1;
  for (;;) {
    const candidate = `${prefix} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    n += 1;
  }
}
