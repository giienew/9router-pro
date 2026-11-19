// Proxy URL scheme validation: undici's ProxyAgent only speaks http/https,
// so a pool with another scheme (ftp://, socks5://, ...) would fail
// confusingly at request time. Reject it at creation/update instead.
import { describe, it, expect } from "vitest";

import { validateProxyUrl } from "../../src/lib/db/repos/proxyPoolsRepo.js";

describe("validateProxyUrl", () => {
  it("accepts http:// and https:// proxy URLs", () => {
    expect(validateProxyUrl("http://proxy.example.com:8080")).toBeNull();
    expect(validateProxyUrl("https://proxy.example.com:8080")).toBeNull();
    expect(validateProxyUrl("http://user:pass@us.q2ip.com:1111")).toBeNull();
    expect(validateProxyUrl("HTTP://proxy.example.com:8080")).toBeNull();
  });

  it("accepts bare host:port values (normalized to http:// at use time)", () => {
    expect(validateProxyUrl("127.0.0.1:7890")).toBeNull();
    expect(validateProxyUrl("us.q2ip.com:1111")).toBeNull();
    expect(validateProxyUrl("user:pass@proxy.example.com:8080")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateProxyUrl("ftp://proxy.example.com:21")).toBe(
      "Proxy URL scheme must be http:// or https://",
    );
    expect(validateProxyUrl("socks5://proxy.example.com:1080")).toBe(
      "Proxy URL scheme must be http:// or https://",
    );
    expect(validateProxyUrl("socks://proxy.example.com:1080")).toBe(
      "Proxy URL scheme must be http:// or https://",
    );
  });

  it("rejects missing or malformed URLs", () => {
    expect(validateProxyUrl("")).toBe("Proxy URL is required");
    expect(validateProxyUrl("   ")).toBe("Proxy URL is required");
    expect(validateProxyUrl(null)).toBe("Proxy URL is required");
    expect(validateProxyUrl("http://")).toBe("Proxy URL is not a valid URL");
    expect(validateProxyUrl("foo bar")).toBe("Proxy URL is not a valid URL");
    expect(validateProxyUrl("us.q2ip.com:1111:user:pass")).toBe("Proxy URL is not a valid URL");
  });
});
