// Audit item 6b (pro.29): the PKCE codeVerifier must never leave the server
// in a JSON response. GET device-code stores it server-side keyed by
// device_code; POST poll reads it back. The browser never sees it.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(() => ({ flowType: "device_code" })),
  generateAuthData: vi.fn(async () => ({ codeVerifier: "generic-verifier", codeChallenge: "challenge" })),
  requestDeviceCode: vi.fn(async () => ({
    device_code: "dev-123",
    user_code: "USER-1",
    verification_uri: "https://example.test/activate",
    verification_uri_complete: "https://example.test/activate?user_code=USER-1",
    interval: 5,
    expires_in: 600,
    codeVerifier: "qoder-own-verifier",
  })),
  exchangeTokens: vi.fn(),
  pollForToken: vi.fn(async () => ({ success: true, tokens: { accessToken: "tok", refreshToken: "rt" } })),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (args) => ({ id: "conn-1", provider: args.provider })),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
}));

vi.mock("open-sse/services/minimaxCodeLease.js", () => ({
  requestLease: vi.fn(),
  requestStatus: vi.fn(),
  resolveLeaseEndpoint: vi.fn(),
  resolveMcodeDataDir: vi.fn(() => "/tmp/mcode"),
  AuthLeaseError: class AuthLeaseError extends Error {},
}));

vi.mock("open-sse/shared/mimoAccount.js", () => ({
  readDesktopPassToken: vi.fn(async () => null),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({
  detectIdeInstalled: vi.fn(async () => ({ installed: false })),
}));

import { GET, POST } from "../../src/app/api/oauth/[provider]/[action]/route.js";
import { pollForToken } from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import { __clearDeviceCodeSessionsForTests } from "../../src/lib/oauth/utils/deviceCodeSessions.js";

const mockedPoll = vi.mocked(pollForToken);
const mockedCreate = vi.mocked(createProviderConnection);

function getDeviceCode() {
  return GET(new Request("http://localhost/api/oauth/qoder/device-code"), {
    params: Promise.resolve({ provider: "qoder", action: "device-code" }),
  });
}

function postPoll(body) {
  return POST(
    new Request("http://localhost/api/oauth/qoder/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "qoder", action: "poll" }) },
  );
}

describe("GET device-code never returns the PKCE verifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearDeviceCodeSessionsForTests();
  });

  it("omits codeVerifier from the JSON body but keeps the user-facing fields", async () => {
    const res = await getDeviceCode();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_code).toBe("dev-123");
    expect(body.user_code).toBe("USER-1");
    expect(body.verification_uri).toBe("https://example.test/activate");
    expect("codeVerifier" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("verifier");
  });

  it("poll succeeds with no client-supplied verifier, using the stored one", async () => {
    const getRes = await getDeviceCode();
    expect(getRes.status).toBe(200);
    const res = await postPoll({ deviceCode: "dev-123", extraData: {} });
    expect(res.status).toBe(200);
    expect(mockedPoll).toHaveBeenCalledWith("qoder", "dev-123", "qoder-own-verifier", {});
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connection.id).toBe("conn-1");
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("the stored verifier is single-use: a second poll without one fails", async () => {
    await getDeviceCode();
    const first = await postPoll({ deviceCode: "dev-123", extraData: {} });
    expect(first.status).toBe(200);
    const second = await postPoll({ deviceCode: "dev-123", extraData: {} });
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("Missing code verifier");
  });

  it("a client-supplied verifier still works as a fallback for in-flight modals", async () => {
    const res = await postPoll({ deviceCode: "dev-999", codeVerifier: "legacy-client-verifier", extraData: {} });
    expect(res.status).toBe(200);
    expect(mockedPoll).toHaveBeenCalledWith("qoder", "dev-999", "legacy-client-verifier", {});
  });
});
