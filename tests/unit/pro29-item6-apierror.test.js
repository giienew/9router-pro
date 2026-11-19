// Audit item 6a (pro.29): migrated catch returns use the canonical
// { error: { code, message } } envelope — same HTTP status, generic
// message, raw internals only in the server log. Route-level proof for
// one apiErrorResponse site and one apiErrorBody site.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tunnel", () => ({
  getTunnelStatus: vi.fn(async () => { throw new Error("/home/user/secret/path exploded"); }),
  getTailscaleStatus: vi.fn(async () => ({ enabled: false })),
  getDownloadStatus: vi.fn(() => ({ state: "idle" })),
}));

vi.mock("@/lib/consoleLogBuffer", () => ({
  clearConsoleLogs: vi.fn(),
  getConsoleLogs: vi.fn(() => { throw new Error("ENOENT /home/user/secret/logs.json"); }),
  initConsoleLogCapture: vi.fn(),
}));

import { GET as tunnelStatus } from "../../src/app/api/tunnel/status/route.js";
import { GET as consoleLogs } from "../../src/app/api/translator/console-logs/route.js";

describe("6a migrated error responses", () => {
  it("tunnel/status returns the envelope with the same 500 and no raw path", async () => {
    const res = await tunnelStatus();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "tunnel_status_failed", message: "Failed to fetch tunnel status" },
    });
    expect(JSON.stringify(body)).not.toContain("/home/user");
  });

  it("translator/console-logs keeps { success:false } with the envelope error", async () => {
    const res = await consoleLogs();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: { code: "translator_logs_failed", message: "Failed to fetch console logs" },
    });
    expect(JSON.stringify(body)).not.toContain("/home/user");
  });
});
