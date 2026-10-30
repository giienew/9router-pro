import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

afterEach(() => { vi.unstubAllGlobals(); });

const body = { state: { prompt: "hi" }, questions: { route: { type: "choice" } } };
const creds = { apiKey: "test-key", providerSpecificData: {} };

describe("handleSystemoneCore abort signal (D5)", () => {
  it("aborts the upstream fetch when the signal is already aborted", async () => {
    const fetchFn = vi.fn(async (_url, opts) => {
      if (opts?.signal?.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchFn);
    const controller = new AbortController();
    controller.abort();
    const result = await handleSystemoneCore({
      body, modelInfo: { provider: "ollama", model: "m" },
      credentials: creds, log: {}, signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].signal).toBeTruthy();
  });

  it("passes the fetch through untouched when no signal is given", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ usage: { input_tokens: 3, output_tokens: 2 } }),
    }));
    vi.stubGlobal("fetch", fetchFn);
    const result = await handleSystemoneCore({
      body, modelInfo: { provider: "ollama", model: "m" },
      credentials: creds, log: {},
    });
    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
  });
});
