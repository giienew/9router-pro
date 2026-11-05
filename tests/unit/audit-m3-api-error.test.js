// Guards the M-3 error boundary: clients receive only a stable code + a
// generic message; the raw message never leaves the server (it goes to the
// server log instead).
import { describe, it, expect, vi } from "vitest";
import { apiErrorBody, apiErrorResponse } from "../../src/lib/apiError.js";

describe("apiErrorBody", () => {
  it("returns { error: { code, message } } with the generic message", () => {
    const body = apiErrorBody(new Error("/home/user/secret/path exploded"), {
      code: "mitm_start_failed",
      message: "Failed to start MITM server",
    });
    expect(body).toEqual({
      error: { code: "mitm_start_failed", message: "Failed to start MITM server" },
    });
    expect(JSON.stringify(body)).not.toContain("/home/user");
  });

  it("accepts a plain string error", () => {
    const body = apiErrorBody("boom", { code: "x_failed", message: "Failed" });
    expect(body.error).toEqual({ code: "x_failed", message: "Failed" });
  });

  it("logs the raw error server-side", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error("raw detail");
    apiErrorBody(raw, { code: "x_failed", message: "Failed" });
    expect(spy).toHaveBeenCalledWith("[api:x_failed]", raw);
    spy.mockRestore();
  });
});

describe("apiErrorResponse", () => {
  it("returns a 500 Response with the canonical body by default", async () => {
    const res = apiErrorResponse(new Error("raw"), {
      code: "headroom_failed",
      message: "Failed to start headroom proxy",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "headroom_failed", message: "Failed to start headroom proxy" },
    });
  });

  it("honours an explicit status", async () => {
    const res = apiErrorResponse(new Error("raw"), {
      code: "rate_limited",
      message: "Too many requests.",
      status: 429,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("Too many requests.");
  });
});
