// Display labels for stored model backings. A custom provider's backing is
// stored as "<node-id>/<model>" because chat routing only resolves the node
// id, but users should see "<prefix>/<model>". Display only: nothing here
// changes a stored backing or a picked value, so it is safe for any current
// or future custom provider node.
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
  return prefix ? `${prefix}${sub.slice(idx)}` : sub;
}
