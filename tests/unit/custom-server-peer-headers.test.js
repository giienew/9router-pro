// custom-server.js is the only thing that makes x-9r-real-ip trustworthy. Boot a real
// HTTP server through it and confirm a client cannot smuggle its own peer headers in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import { __test__ as requestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const require = createRequire(import.meta.url);

let server;
let baseUrl;
let seenHeaders;

beforeAll(async () => {
  require("../../custom-server.js");
  server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(headers = {}) {
  await fetch(baseUrl, { headers });
  return seenHeaders;
}

describe("custom-server peer header sanitizing", () => {
  it("generates a peer trust token at boot", () => {
    expect(process.env.NINEROUTER_PEER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it("replaces a client-supplied x-9r-real-ip with the socket address", async () => {
    const headers = await get({ "x-9r-real-ip": "203.0.113.55" });

    expect(headers["x-9r-real-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("stamps the trust token so downstream can tell the wrapper ran", async () => {
    const headers = await get();

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
  });

  it("drops a client-supplied peer trust token", async () => {
    const headers = await get({ "x-9r-peer-token": "forged-token" });

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
    expect(headers["x-9r-peer-token"]).not.toBe("forged-token");
  });

  it("drops a client-supplied x-9r-via-proxy marker", async () => {
    const headers = await get({ "x-9r-via-proxy": "1" });

    expect(headers["x-9r-via-proxy"]).toBeUndefined();
  });

  it("marks via-proxy and adopts the forwarded IP for a loopback proxy hop", async () => {
    const headers = await get({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(headers["x-9r-via-proxy"]).toBe("1");
    expect(headers["x-9r-real-ip"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  // chat.js snapshots every client header into the request detail. Anything that grants
  // access must not survive into a record the dashboard renders and cloud sync uploads.
  it("keeps the peer token out of persisted request details", () => {
    const sanitized = requestDetails.sanitizeHeaders({
      "x-9r-peer-token": "secret",
      "x-9r-cli-token": "secret",
      "authorization": "Bearer sk-x",
      "x-9r-real-ip": "127.0.0.1",
    });

    expect(sanitized["x-9r-peer-token"]).toBeUndefined();
    expect(sanitized["x-9r-cli-token"]).toBeUndefined();
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["x-9r-real-ip"]).toBe("127.0.0.1");
  });
});

// Audit item 6g: cf-connecting-ip is only trustworthy from a Cloudflare
// edge peer or the local tunnel peer. custom-server.js is the enforcement
// point — it strips the header from any other TCP peer before Next sees it.
describe("custom-server cf-connecting-ip trust", () => {
  const { __test__ } = require("../../custom-server.js");
  const { isTrustedCfPeer } = __test__;

  it("trusts loopback (tunnel/cloudflared) peers, including ::ffff: form", () => {
    expect(isTrustedCfPeer("127.0.0.1")).toBe(true);
    expect(isTrustedCfPeer("::1")).toBe(true);
    expect(isTrustedCfPeer("::ffff:127.0.0.1")).toBe(true);
  });

  it("trusts Cloudflare edge ranges (v4 and v6) and rejects neighbours", () => {
    expect(isTrustedCfPeer("173.245.48.1")).toBe(true);
    expect(isTrustedCfPeer("104.16.23.45")).toBe(true);
    expect(isTrustedCfPeer("131.0.72.200")).toBe(true);
    expect(isTrustedCfPeer("2400:cb00:1234::1")).toBe(true);
    expect(isTrustedCfPeer("2606:4700:abcd::1")).toBe(true);
    expect(isTrustedCfPeer("173.245.64.1")).toBe(false); // just outside 173.245.48.0/20
    expect(isTrustedCfPeer("203.0.113.9")).toBe(false);
    expect(isTrustedCfPeer("8.8.8.8")).toBe(false);
    expect(isTrustedCfPeer("2400:cb01::1")).toBe(false);
    expect(isTrustedCfPeer("not-an-ip")).toBe(false);
    expect(isTrustedCfPeer(null)).toBe(false);
  });

  it("keeps cf-connecting-ip from a loopback (tunnel) peer", async () => {
    const headers = await get({ "cf-connecting-ip": "203.0.113.9" });
    expect(headers["cf-connecting-ip"]).toBe("203.0.113.9");
  });

  it("strips a spoofed cf-connecting-ip when the TCP peer is a direct public address", async () => {
    // No real non-loopback socket is available in the sandbox (egress
    // blocks it), so drive the wrapper with a synthetic request whose
    // socket peer is a public IP — the exact branch a direct client hits.
    const seen = await new Promise((resolve) => {
      const fakeReq = {
        socket: { remoteAddress: "203.0.113.55" },
        headers: { "cf-connecting-ip": "203.0.113.99", "x-forwarded-for": "198.51.100.1" },
      };
      const fakeRes = { end: () => resolve(fakeReq.headers) };
      server.emit("request", fakeReq, fakeRes);
    });
    expect(seen["cf-connecting-ip"]).toBeUndefined();
    expect(seen["x-9r-real-ip"]).toBe("203.0.113.55");
  });
});
