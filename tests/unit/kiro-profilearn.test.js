// Kiro profileArn distinction (P1-14): an account whose ARN could not be
// resolved is skipped at selection for OAuth/social auth (where the
// translator would inject the shared default ARN and 403), instead of
// flapping on generic per-model locks. Account-bound auth never uses the
// default, so it is unaffected. Auto-import keeps an ARN's own region.
// Run from tests/:
//   bun x vitest run unit/kiro-profilearn.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body) => ({ body }) },
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-kiro-arn-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("../../src/sse/services/auth.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function kiroConn(tag, psd) {
  return db.createProviderConnection({
    provider: "kiro", authType: "oauth", name: `kiro-${tag}`,
    accessToken: "tok", refreshToken: `rt-${tag}`,
    providerSpecificData: psd,
  });
}

describe("kiro profileArn selection", () => {
  it("skips unresolved OAuth/social accounts, picks a stored-ARN one", async () => {
    const flagged = await kiroConn("flagged", { authMethod: "builder-id", profileArnUnresolved: true });
    const good = await kiroConn("good", {
      authMethod: "builder-id",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
    });
    const picked = await auth.getProviderCredentials("kiro");
    expect(picked?.connectionId).toBe(good.id);
    expect(picked?.connectionId).not.toBe(flagged.id);
  });

  it("returns null when only unresolved accounts exist", async () => {
    // Fresh DB state per file would be ideal; instead exclude the good
    // account from the previous test and rely on the skip for the rest.
    const conns = await db.getProviderConnections({ provider: "kiro" });
    const good = conns.find((c) => c.providerSpecificData?.profileArn);
    const picked = await auth.getProviderCredentials("kiro", good ? new Set([good.id]) : null);
    expect(picked).toBeNull();
  });

  it("account-bound auth with the flag is NOT skipped", async () => {
    const apiKeyConn = await kiroConn("apikey", { authMethod: "api_key", profileArnUnresolved: true });
    const conns = await db.getProviderConnections({ provider: "kiro" });
    const exclude = new Set(conns.map((c) => c.id).filter((id) => id !== apiKeyConn.id));
    const picked = await auth.getProviderCredentials("kiro", exclude);
    expect(picked?.connectionId).toBe(apiKeyConn.id);
  });
});

describe("normalizeKiroArnRegion", () => {
  it("keeps a present region, fills us-east-1 only when missing", async () => {
    const { normalizeKiroArnRegion } = await import("../../src/app/api/oauth/kiro/auto-import/route.js");
    expect(normalizeKiroArnRegion("arn:aws:codewhisperer:eu-west-1:123:profile/ABC"))
      .toBe("arn:aws:codewhisperer:eu-west-1:123:profile/ABC");
    expect(normalizeKiroArnRegion("arn:aws:codewhisperer:us-east-1:123:profile/ABC"))
      .toBe("arn:aws:codewhisperer:us-east-1:123:profile/ABC");
    expect(normalizeKiroArnRegion("arn:aws:codewhisperer::123:profile/ABC"))
      .toBe("arn:aws:codewhisperer:us-east-1:123:profile/ABC");
  });
});
