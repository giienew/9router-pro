// Variant naming helpers (pure, no React/JSX) — shared by the Prompt
// Injection form and its tests.

// Derive a variant name from a model: provider + model slug, e.g.
// "dahl/deepseek-ai/DeepSeek-V4-Flash-0731" -> "dahl-deepseek-v4-flash-0731".
export function slugVariant(model) {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "custom";
  const providerPart = provider.startsWith("openai-compatible-chat-") ? "custom" : provider;
  const last = model.slice(model.lastIndexOf("/") + 1);
  const slugged = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  return `${providerPart}-${slugged}`.slice(0, 80);
}

// Auto variant name: <slug>-JB, and -JB2 / -JB3 … when that name is taken.
// Bare names (a combo backing, no "/") slug from the name itself.
export function suggestVariantName(model, existingNames) {
  const m = (model || "").trim();
  if (!m) return "";
  const base = m.includes("/")
    ? slugVariant(m)
    : m.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  const taken = new Set(existingNames || []);
  let n = 1;
  for (;;) {
    const suffix = n === 1 ? "-JB" : `-JB${n}`;
    const candidate = base.slice(0, 80 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
    n++;
    if (n > 999) return candidate;
  }
}
