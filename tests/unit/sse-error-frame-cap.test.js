// P1-17c: upstream SSE error frames in non-streaming responses surface
// the real upstream status/message instead of a generic 502 (or an error
// object passed through as a successful body). The surfaced status then
// drives failover classification: a 429 counts toward the member cap,
// a request-scoped 4xx advances the combo without locking the account.
// Run from tests/:
//   bun x vitest run unit/sse-error-frame-cap.test.js
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

function sseResponse(errorObj) {
  return {
    status: 200,
    statusText: "OK",
    headers: { get: () => "text/event-stream" },
    text: async () => `data: ${JSON.stringify({ error: errorObj })}\n\ndata: [DONE]\n\n`,
  };
}

function callHandler(providerResponse) {
  return handleNonStreamingResponse({
    providerResponse,
    provider: "dahl",
    model: "dahl/test",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { stream: false },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k1",
    clientRawRequest: null,
    onRequestSuccess: () => {},
    reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
    toolNameMap: null,
    customToolNames: null,
    trackDone: () => {},
    appendLog: () => {},
    pxpipe: null,
    reqTag: "test",
    log: null,
  });
}

describe("SSE error frames in non-streaming responses", () => {
  it("surfaces a 429 frame, which the failover cap counts", async () => {
    const result = await callHandler(sseResponse({ status: 429, message: "rate limited" }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toMatch(/rate limited/);
    // Cap interplay: account fallback counts this failure.
    expect(checkFallbackError(result.status, result.error).shouldFallback).toBe(true);
  });

  it("surfaces a request-scoped 400 frame, which the cap does not count", async () => {
    const result = await callHandler(sseResponse({ status: 400, message: "bad request" }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    const verdict = checkFallbackError(result.status, result.error);
    expect(verdict.shouldFallback).toBe(false);
    expect(verdict.requestScoped).toBe(true);
  });

  it("maps a missing or out-of-range status to 502", async () => {
    const noStatus = await callHandler(sseResponse({ message: "boom" }));
    expect(noStatus.status).toBe(502);
    const badStatus = await callHandler(sseResponse({ status: 200, message: "boom" }));
    expect(badStatus.status).toBe(502);
  });
});
