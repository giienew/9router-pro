// Proxy precedence (P1-13): an explicitly picked pool beats rotation in
// the no-auth free lane; rotation still runs when no pool is picked.
// Run from tests/:
//   bun x vitest run unit/proxy-resolution.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;
let freeId;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proxy-res-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("../../src/sse/services/auth.js");
  const { FREE_PROVIDERS } = await import("@/shared/constants/providers.js");
  freeId = Object.keys(FREE_PROVIDERS).find((id) => FREE_PROVIDERS[id]?.noAuth);
  expect(freeId).toBeTruthy();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function twoPools() {
  const a = await db.createProxyPool({ name: "pool-a", proxyUrl: "http://127.0.0.1:9001", isActive: true });
  const b = await db.createProxyPool({ name: "pool-b", proxyUrl: "http://127.0.0.1:9002", isActive: true });
  return [a, b];
}

describe("no-auth proxy precedence", () => {
  it("an explicit pool beats a configured rotation", async () => {
    const [a, b] = await twoPools();
    await db.updateSettings({
      providerStrategies: {
        [freeId]: { proxyPoolId: a.id, rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
      },
    });
    const creds = await auth.getProviderCredentials(freeId);
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe(a.id);
    expect(creds.providerSpecificData.connectionProxyEnabled).toBe(true);
  });

  it("rotation still runs when no explicit pool is picked", async () => {
    const [a, b] = await twoPools();
    await db.updateSettings({
      providerStrategies: {
        [freeId]: { rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
      },
    });
    const creds = await auth.getProviderCredentials(freeId);
    expect([a.id, b.id]).toContain(creds.providerSpecificData.connectionProxyPoolId);
  });
});
