import { describe, it, expect } from "vitest";
import {
  newRequestId,
  requestIdFromRequest,
  attachRequestId,
  REQUEST_ID_HEADER,
} from "../../src/sse/utils/requestId.js";

describe("request id (D6)", () => {
  it("mints ids with a req_ prefix", () => {
    expect(newRequestId()).toMatch(/^req_[a-z0-9]+-[a-z0-9]+$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
  it("keeps a sane client-supplied id and mints one otherwise", () => {
    const keep = requestIdFromRequest({ headers: new Headers({ [REQUEST_ID_HEADER]: "client-123" }) });
    expect(keep).toBe("client-123");
    const minted = requestIdFromRequest({ headers: new Headers({ [REQUEST_ID_HEADER]: "bad id with spaces!" }) });
    expect(minted).toMatch(/^req_/);
    expect(requestIdFromRequest({ headers: new Headers() })).toMatch(/^req_/);
  });
  it("attaches the header without touching status or body", async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    const out = attachRequestId(res, "req_abc");
    expect(out.headers.get(REQUEST_ID_HEADER)).toBe("req_abc");
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
  });
  it("passes null responses through", () => {
    expect(attachRequestId(null, "req_abc")).toBeNull();
  });
});
