import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // PM2 (and `node server.js`) runs the generated standalone server.js,
  // NOT custom-server.js — so the request sanitizer and the peer-token
  // stamping (x-9r-real-ip / x-9r-peer-token) never ran, and every chat
  // row recorded clientIp "unknown" (spam ranking useless). Prepend the
  // wrapper require so the standalone boots through the sanitizer even
  // when started as `node server.js`: requiring the wrapper only installs
  // the http.createServer patch (its server-start block runs only when it
  // is the main module), then the generated server code below runs on the
  // patched createServer. Idempotent — a second postbuild skips it.
  const standaloneServer = resolve(standaloneDir, "server.js");
  if (existsSync(standaloneServer) && existsSync(serverWrapperDestination)) {
    const orig = readFileSync(standaloneServer, "utf8");
    if (!orig.includes("custom-server.js")) {
      writeFileSync(standaloneServer, `require("./custom-server.js");\n${orig}`);
      console.log("[standalone-assets] Prepended custom-server.js to standalone server.js");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
