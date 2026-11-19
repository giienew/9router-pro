// Admin helpers (9Router Pro, pro.29) — pure, no Node imports, so both the
// server routes and the Admin client can use them.
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${Number.isInteger(x) ? String(x) : x.toFixed(1)} ${units[i]}`;
}

// Pick the 9Router PM2 process out of a `pm2 jlist` array. Prefers the
// exact "9router-pro" name, then any name/script path mentioning 9router.
// Returns { name, status, pid } or null when PM2 runs no 9router process.
export function resolvePm2Target(jlist) {
  if (!Array.isArray(jlist)) return null;
  const candidates = [];
  for (const p of jlist) {
    if (!p || typeof p !== "object") continue;
    const name = String(p.name || "");
    const script = String(p?.pm2_env?.pm_exec_path || p?.pm2_env?.script || "");
    if (/9router/i.test(name) || /9router/i.test(script)) {
      candidates.push({
        name,
        status: String(p?.pm2_env?.status || ""),
        pid: Number(p?.pid) || null,
      });
    }
  }
  if (!candidates.length) return null;
  return (
    candidates.find((c) => c.name === "9router-pro") ||
    candidates.find((c) => c.name === "9router") ||
    candidates[0]
  );
}
