// Display labels for stored model backings. A custom provider's backing is
// stored as "<node-id>/<model>" because chat routing only resolves the node
// id, but users should see "<prefix>/<model>". Display only: nothing here
// changes a stored backing or a picked value, so it is safe for any current
// or future custom provider node.
import {
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
  CUSTOM_EMBEDDING_PREFIX,
} from "@/shared/constants/providers";

export function nodePrefixById(nodes) {
  const map = {};
  for (const n of nodes || []) {
    if (n?.id) map[n.id] = n.prefix || n.name || null;
  }
  return map;
}

export function displayBacking(sub, prefixById) {
  if (!sub || !sub.includes("/")) return sub;
  const idx = sub.indexOf("/");
  const prefix = prefixById?.[sub.slice(0, idx)];
  if (prefix) return `${prefix}${sub.slice(idx)}`;
  // Deleted node, or the /api/provider-nodes fetch failed: the head is a raw
  // node id (openai-compatible-chat-<uuid>/...). Never leak the id — show
  // the generic "custom/<model>" label instead.
  const head = sub.slice(0, idx);
  if (
    head.startsWith(OPENAI_COMPATIBLE_PREFIX) ||
    head.startsWith(ANTHROPIC_COMPATIBLE_PREFIX) ||
    head.startsWith(CUSTOM_EMBEDDING_PREFIX)
  ) {
    return `custom${sub.slice(idx)}`;
  }
  return sub;
}
