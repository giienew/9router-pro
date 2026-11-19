// pro.29 item G — SSE compression-safe headers: no SSE header set in the
// tree sets Content-Encoding (in particular no "Content-Encoding: identity"
// guard exists to drop — the shared SSE constants and every SSE route only
// set Content-Type / Cache-Control / Connection / X-Accel-Buffering / CORS),
// so a compressing proxy cannot corrupt streams by double-encoding them.
// Run: npx vitest run unit/pro29-item-g-sse-headers.test.js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("SSE headers", () => {
  it("the shared SSE header guard sets no Content-Encoding", () => {
    const guard = read("open-sse/utils/sseConstants.js");
    expect(guard).toContain("SSE_HEADERS");
    expect(guard).toContain("SSE_HEADERS_NO_BUFFER");
    expect(guard).toContain("SSE_HEADERS_CORS");
    expect(guard).toContain('"Content-Type": "text/event-stream"');
    expect(guard).toContain('"Cache-Control": "no-cache"');
    expect(guard).toContain('"X-Accel-Buffering": "no"');
    expect(guard).not.toContain("Content-Encoding");
    expect(guard).not.toContain("identity");
  });

  it("no SSE route sets Content-Encoding: identity", () => {
    const files = [
      ...jsFiles(path.resolve(REPO_ROOT, "src/app/api")),
      ...jsFiles(path.resolve(REPO_ROOT, "src/sse")),
      path.resolve(REPO_ROOT, "open-sse/utils/sseConstants.js"),
    ];
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf-8");
      return (
        src.includes('"Content-Encoding": "identity"') ||
        src.includes("'Content-Encoding': 'identity'") ||
        src.includes("Content-Encoding: identity")
      );
    });
    expect(offenders).toEqual([]);
  });
});
