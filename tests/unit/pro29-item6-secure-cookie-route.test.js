// Audit item 6e (pro.29): the SSO state cookies must be Secure by default.
// Route-level proof for GET /api/auth/saml/start: the cookie is set with
// secure:true unless AUTH_COOKIE_SECURE=false. (The main dashboard session
// cookie lives in src/lib/auth/dashboardSession.js, owned by another agent
// in this audit — see the task report.)
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mocks.cookieSet })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ samlEntryPoint: "https://idp.example.com/sso", samlCert: "cert" })),
}));

vi.mock("@/lib/auth/saml.js", () => ({
  isSamlConfigured: vi.fn(() => true),
  buildSamlAuthorizeUrl: vi.fn(async () => ({ authorizeUrl: "https://idp.example.com/sso?x=1", requestId: "req-1" })),
  getSamlBaseUrl: vi.fn(() => "http://localhost:3000"),
}));

import { GET } from "../../src/app/api/auth/saml/start/route.js";

describe("GET /api/auth/saml/start sets a Secure state cookie by default", () => {
  const OLD = process.env.AUTH_COOKIE_SECURE;
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => {
    if (OLD === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = OLD;
  });

  it("sets saml_state with secure:true when the env is unset", async () => {
    delete process.env.AUTH_COOKIE_SECURE;
    const res = await GET(new Request("http://localhost/api/auth/saml/start"));
    expect(res.status).toBe(307);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "saml_state",
      "req-1",
      expect.objectContaining({ secure: true, httpOnly: true, sameSite: "lax" }),
    );
  });

  it("sets saml_state with secure:false only on explicit opt-out", async () => {
    process.env.AUTH_COOKIE_SECURE = "false";
    await GET(new Request("http://localhost/api/auth/saml/start"));
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "saml_state",
      "req-1",
      expect.objectContaining({ secure: false }),
    );
  });
});
