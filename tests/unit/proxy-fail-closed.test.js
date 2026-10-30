// Proxy fail-closed (P1-13): when the pool lookup itself throws, a
// requested pool must never silently fall back to the direct IP — the
// error config carries strictProxy so the fetch layer fails loudly.
// No pool requested → direct was the intent, nothing to protect.
// The DB file is a directory, so every adapter open fails.
// Run from tests/:
//   bun x vitest run unit/proxy-fail-closed.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let proxy;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proxy-fc-"));
  fs.mkdirSync(path.join(tempDir, "db", "data.sqlite"), { recursive: true });
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  proxy = await import("../../src/lib/network/connectionProxy.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("proxy resolution failure", () => {
  it("fails closed when a pool was requested", async () => {
    const cfg = await proxy.resolveConnectionProxyConfig({ proxyPoolId: "pool-x" });
    expect(cfg.source).toBe("error");
    expect(cfg.strictProxy).toBe(true);
    expect(cfg.proxyPoolId).toBe("pool-x");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });

  it("stays direct when no pool was requested", async () => {
    // No pool requested → the DB is never touched, so the normal "none"
    // config comes back (direct was the intent, nothing to protect).
    const cfg = await proxy.resolveConnectionProxyConfig({});
    expect(cfg.source).toBe("none");
    expect(cfg.strictProxy).toBe(false);
    const none = await proxy.resolveConnectionProxyConfig({ proxyPoolId: "__none__" });
    expect(none.source).toBe("none");
    expect(none.strictProxy).toBe(false);
  });
});
