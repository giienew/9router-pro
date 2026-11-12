// Deterministic JSON serialization for outbound provider request bodies.
// Same observable semantics as JSON.stringify (drops undefined/function/symbol
// object values, nulls undefined array items, honors toJSON, throws on
// BigInt — exactly like JSON.stringify), but object keys are sorted so the
// same logical request always serializes to the same bytes. Stable bytes
// keep upstream prefix caching alive when the body is assembled from
// different code paths (user overrides, different routes) that would
// otherwise shuffle key order. (Circular input stack-overflows here while
// JSON.stringify throws a TypeError — request bodies are plain data, so
// this cannot occur on this path.)
export function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
    return JSON.stringify(value);
  }
  if (typeof value.toJSON === "function") return stableJsonStringify(value.toJSON());
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return "null";
      return stableJsonStringify(item);
    });
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    parts.push(`${JSON.stringify(k)}:${stableJsonStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}
