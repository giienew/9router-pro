/**
 * `9router doctor` — diagnose a Pro install without changing anything.
 * Read-only: checks Node, the server port, local config/runtime dirs and,
 * if the server is up, its /api/health endpoint. Exit 0 = no FAIL rows,
 * 1 = at least one FAIL row. Never prints a key or password.
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const HELP = `
Usage: 9router doctor [--port <n>] [--json]

Diagnose this machine's 9Router Pro setup. Read-only, no writes, no keys printed.

  9router doctor               # defaults: port from PORT env or 3000
  9router doctor --port 20127  # check a different server port
  9router doctor --json        # machine-readable output
`;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
  });
}

async function health(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { up: false, status: res.status };
    const json = await res.json().catch(() => ({}));
    return { up: true, status: res.status, version: json.version || json.appVersion || null };
  } catch {
    return { up: false, status: null };
  }
}

async function run(argv) {
  const opts = { port: Number(process.env.PORT) || 3000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error("Invalid --port value");
      opts.port = v;
    } else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else throw new Error(`Unknown option: ${a}`);
  }

  const rows = [];
  const check = (name, status, detail) => rows.push({ name, status, detail });

  const major = Number(process.version.slice(1).split(".")[0]);
  check("node", major >= 22 ? "ok" : "fail", `${process.version} (Pro needs Node >= 22)`);
  const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    check("package", "ok", `${pkg.name}@${pkg.version}`);
  } catch (err) { check("package", "fail", `cannot read package.json: ${err.message}`); }

  const dataDir = path.join(os.homedir(), ".9router");
  check("data-dir", fs.existsSync(dataDir) ? "ok" : "warn", `${dataDir}${fs.existsSync(dataDir) ? "" : " (missing — created on first server start)"}`);
  check("runtime-dir", fs.existsSync(path.join(dataDir, "runtime")) ? "ok" : "warn", "SQLite runtime (self-heals on server start)");
  check("env-file", fs.existsSync(path.join(process.cwd(), ".env.local")) ? "ok" : "warn", ".env.local in current directory (PORT / INITIAL_PASSWORD live here after `9router setup`)");

  const inUse = await portInUse(opts.port);
  check("port", "info", `${opts.port} ${inUse ? "in use (a server may already be running)" : "free"}`);
  const h = await health(opts.port);
  check("server", h.up ? "ok" : "warn", h.up ? `reachable, status ${h.status}${h.version ? `, version ${h.version}` : ""}` : "not reachable on this port (start it, or pass --port)");

  if (opts.json) {
    console.log(JSON.stringify({ port: opts.port, checks: rows }, null, 2));
  } else {
    console.log(`\n9Router Pro doctor — port ${opts.port}\n`);
    for (const r of rows) {
      const mark = r.status === "ok" ? "✅" : r.status === "fail" ? "❌" : r.status === "warn" ? "⚠️" : "ℹ️";
      console.log(`${mark} ${r.name}: ${r.detail}`);
    }
    console.log("");
  }
  return rows.some((r) => r.status === "fail") ? 1 : 0;
}

module.exports = { run };
