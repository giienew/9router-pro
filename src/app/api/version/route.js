import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

// 9Router Pro — update checks follow the Pro GitHub repo's releases
// (tags like "v0.5.104-pro.2"), not the upstream npm package.
const PRO_REPO = "giienew/9router-pro";
const VERSION_CACHE_TTL_MS = 3600000; // cache latest-release lookup for 1h

// Survive hot reload; one cache per process
const versionCache = (global.__proVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch the latest Pro release tag from GitHub
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${PRO_REPO}/releases/latest`,
      { timeout: 4000, headers: { "User-Agent": "9router-pro", Accept: "application/vnd.github+json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const tag = JSON.parse(data).tag_name || null;
            resolve(tag ? tag.replace(/^v/, "") : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// "0.5.104-pro.2" -> { base: [0,5,104], pro: 2 } (pro suffix absent = 0)
function parseVersion(v) {
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-pro\.(\d+))?/);
  if (!m) return null;
  return { base: [Number(m[1]), Number(m[2]), Number(m[3])], pro: m[4] ? Number(m[4]) : 0 };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1;
    if (pa.base[i] < pb.base[i]) return -1;
  }
  if (pa.pro !== pb.pro) return pa.pro > pb.pro ? 1 : -1;
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = await getLatestVersionCached();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
