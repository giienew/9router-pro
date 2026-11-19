import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: when every part is text, join them
// into a plain string (string content is accepted by every OpenAI-compatible
// endpoint; array content is rejected by some strict ones). Otherwise the
// array is returned as-is so image/tool parts survive. A part carrying
// cache_control must never collapse: string content cannot carry the marker,
// so joining would silently drop the client's prompt-caching breakpoint.
export function collapseTextParts(parts) {
  if (parts.length === 0) return parts;
  if (parts.some((p) => p?.cache_control)) return parts;
  if (parts.every((p) => p.type === OPENAI_BLOCK.TEXT)) {
    return parts.map((p) => p.text || "").join("\n");
  }
  return parts;
}
