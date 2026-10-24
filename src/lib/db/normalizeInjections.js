// Import-time sync for prompt injections: entries keyed by combo names
// expand to the resolved "provider/model" of that combo's leaves, and
// entries keyed by bare model ids expand to every provider/model that
// serves that bare id — so a backup written before the provider/model
// concept behaves like current data after import.
// Pure and fail-open: a key that resolves to no provider/model keeps its
// entry untouched, and existing provider/model entries are never
// overwritten. resolveProvider maps a leaf's provider part (node prefix
// or registry alias) to the provider id the request path uses; it
// defaults to identity for callers without alias data.
export async function normalizePromptMap(promptsMap, combos, resolveProvider) {
  if (!promptsMap || typeof promptsMap !== "object" || Array.isArray(promptsMap)) return promptsMap;
  const byName = new Map();
  for (const c of Array.isArray(combos) ? combos : []) {
    if (c && typeof c.name === "string" && Array.isArray(c.models)) byName.set(c.name, c.models);
  }
  const resolveLeaves = (name, seen) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const members = byName.get(name);
    if (!members) return [];
    const out = [];
    for (const m of members) {
      if (typeof m !== "string") continue;
      if (byName.has(m)) out.push(...resolveLeaves(m, seen));
      else out.push(m);
    }
    return out;
  };
  // All leaves of all combos (for bare-key expansion).
  const allLeaves = [];
  for (const name of byName.keys()) allLeaves.push(...resolveLeaves(name, new Set()));
  const resolveLeaf = async (leaf) => {
    const i = leaf.indexOf("/");
    if (i <= 0) return null;
    const provider = leaf.slice(0, i);
    const model = leaf.slice(i + 1);
    const resolved = resolveProvider ? await resolveProvider(provider) : provider;
    return resolved ? `${resolved}/${model}` : null;
  };
  const bareOf = (leaf) => {
    const i = leaf.indexOf("/");
    return i > 0 ? leaf.slice(i + 1) : leaf;
  };
  const out = { ...promptsMap };
  for (const [key, entry] of Object.entries(promptsMap)) {
    let leaves = [];
    if (byName.has(key)) {
      leaves = resolveLeaves(key, new Set());
    } else {
      // Bare-key expansion: every leaf whose bare part equals the key.
      leaves = allLeaves.filter((leaf) => bareOf(leaf) === key);
    }
    if (leaves.length === 0) continue;
    const targets = new Set();
    for (const leaf of leaves) {
      const t = await resolveLeaf(leaf);
      if (t) targets.add(t);
    }
    if (targets.size === 0) continue;
    for (const t of targets) {
      if (!(t in out)) out[t] = entry;
    }
    delete out[key];
  }
  return out;
}

// Same expansion inside each per-key map of a byKeyModel payload.
export async function normalizeKeyModelMap(keyModelMap, combos, resolveProvider) {
  if (!keyModelMap || typeof keyModelMap !== "object" || Array.isArray(keyModelMap)) return keyModelMap;
  const out = {};
  for (const [keyId, map] of Object.entries(keyModelMap)) {
    out[keyId] = await normalizePromptMap(map, combos, resolveProvider);
  }
  return out;
}

// Resolver for the callers above: provider-node prefixes (user-defined,
// DB-backed) win, registry aliases resolve next, everything else passes
// through unchanged. Mirrors the request path's provider resolution.
export function buildProviderResolver(nodes, resolveAlias) {
  const byPrefix = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || !n.id) continue;
    const prefix = n.prefix || (n.data && n.data.prefix);
    if (typeof prefix === "string" && prefix) byPrefix.set(prefix, n.id);
  }
  return (provider) => {
    if (byPrefix.has(provider)) return byPrefix.get(provider);
    return resolveAlias ? resolveAlias(provider) : provider;
  };
}
