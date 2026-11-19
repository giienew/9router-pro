import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LIVE_MODEL_FEED_TTL_MS,
  parseLiveModelFeed,
  findLiveLimits,
  fetchLiveModelFeed,
  clearLiveModelFeedCache,
} from "../../src/lib/liveModelFeed.js";

const URL = "https://gw.example.test/v1/models";
const HEADERS = { Authorization: "Bearer sk-test-1" };

function okFeed(data) {
  return { ok: true, json: async () => data };
}

describe("parseLiveModelFeed", () => {
  it("reads OpenAI-style data with snake_case limits", () => {
    const parsed = parseLiveModelFeed({
      object: "list",
      data: [
        { id: "model-a", context_length: 65536, max_completion_tokens: 8192 },
        { id: "model-b", context_length: 128000 },
        { id: "model-c" },
      ],
    });
    expect(parsed.ids).toEqual(["model-a", "model-b", "model-c"]);
    expect(parsed.limits.get("model-a")).toEqual({ contextWindow: 65536, maxOutput: 8192 });
    expect(parsed.limits.get("model-b")).toEqual({ contextWindow: 128000 });
    expect(parsed.limits.has("model-c")).toBe(false);
  });

  it("accepts a bare array and the models/results envelopes", () => {
    expect(parseLiveModelFeed([{ id: "x", context_length: 1000 }]).ids).toEqual(["x"]);
    expect(parseLiveModelFeed({ models: [{ id: "y", context_length: 2000 }] }).ids).toEqual(["y"]);
    expect(parseLiveModelFeed({ results: [{ id: "z", context_length: 3000 }] }).ids).toEqual(["z"]);
  });

  it("accepts camelCase limit spellings and id fallbacks", () => {
    const parsed = parseLiveModelFeed({
      data: [
        { name: "by-name", context_window: 32000, max_output_tokens: 4000 },
        { model: "by-model", context_length: 16000 },
      ],
    });
    expect(parsed.ids).toEqual(["by-name", "by-model"]);
    expect(parsed.limits.get("by-name")).toEqual({ contextWindow: 32000, maxOutput: 4000 });
  });

  it("ignores entries without an id and non-positive limits", () => {
    const parsed = parseLiveModelFeed({
      data: [
        { context_length: 1000 },
        { id: "  " },
        { id: "bad", context_length: 0, max_completion_tokens: -5 },
        { id: "str", context_length: "not-a-number" },
        { id: "dup", context_length: 100 },
        { id: "dup", context_length: 200 },
      ],
    });
    expect(parsed.ids).toEqual(["bad", "str", "dup"]);
    expect(parsed.limits.has("bad")).toBe(false);
    expect(parsed.limits.has("str")).toBe(false);
    expect(parsed.limits.get("dup")).toEqual({ contextWindow: 100 });
  });

  it("returns empty lists for null, garbage, and empty payloads", () => {
    for (const data of [null, undefined, "nope", 42, {}, { data: null }]) {
      const parsed = parseLiveModelFeed(data);
      expect(parsed.ids).toEqual([]);
      expect(parsed.limits.size).toBe(0);
    }
  });
});

describe("findLiveLimits", () => {
  const limits = new Map([
    ["model-a", { contextWindow: 1000 }],
    ["DeepSeek-V4-Flash-0731", { contextWindow: 2000, maxOutput: 4000 }],
  ]);

  it("matches the exact id first", () => {
    expect(findLiveLimits(limits, "model-a")).toEqual({ contextWindow: 1000 });
  });

  it("falls back to the last path segment", () => {
    expect(findLiveLimits(limits, "deepseek-ai/DeepSeek-V4-Flash-0731")).toEqual({
      contextWindow: 2000,
      maxOutput: 4000,
    });
  });

  it("returns null on no match, bad input, or a non-Map", () => {
    expect(findLiveLimits(limits, "missing")).toBeNull();
    expect(findLiveLimits(limits, "")).toBeNull();
    expect(findLiveLimits(null, "model-a")).toBeNull();
    expect(findLiveLimits({}, "model-a")).toBeNull();
  });
});

describe("fetchLiveModelFeed", () => {
  beforeEach(() => {
    clearLiveModelFeedCache();
  });

  it("returns parsed limits and caches ~5 minutes per credential", async () => {
    const fetchImpl = vi.fn(async () => okFeed({
      data: [{ id: "model-a", context_length: 65536, max_completion_tokens: 8192 }],
    }));
    let nowMs = 1_000_000;
    const opts = { url: URL, headers: HEADERS, fetchImpl, now: () => nowMs };

    const first = await fetchLiveModelFeed(opts);
    const second = await fetchLiveModelFeed(opts);
    expect(first.ids).toEqual(["model-a"]);
    expect(first.limits.get("model-a")).toEqual({ contextWindow: 65536, maxOutput: 8192 });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Still cached just inside the TTL…
    nowMs += LIVE_MODEL_FEED_TTL_MS - 1;
    await fetchLiveModelFeed(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // …and refetched once the TTL expires.
    nowMs += 2;
    await fetchLiveModelFeed(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a separate cache entry per credential on the same URL", async () => {
    const fetchImpl = vi.fn(async () => okFeed({ data: [{ id: "m", context_length: 100 }] }));
    const a = await fetchLiveModelFeed({ url: URL, headers: { Authorization: "Bearer key-a" }, fetchImpl });
    const b = await fetchLiveModelFeed({ url: URL, headers: { Authorization: "Bearer key-b" }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    // Same credential again hits its own entry.
    await fetchLiveModelFeed({ url: URL, headers: { Authorization: "Bearer key-a" }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight fetches", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const pending = Promise.all([
      fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl }),
      fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(okFeed({ data: [{ id: "m", context_length: 100 }] }));
    const [a, b] = await pending;
    expect(a).toBe(b);
    expect(a.ids).toEqual(["m"]);
  });

  it("returns null on non-2xx, network throw, and bad JSON — never throws", async () => {
    const cases = [
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      vi.fn(async () => { throw new Error("boom"); }),
      vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } })),
    ];
    for (const fetchImpl of cases) {
      clearLiveModelFeedCache();
      await expect(fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl })).resolves.toBeNull();
    }
    expect(await fetchLiveModelFeed({ url: "", headers: HEADERS, fetchImpl: vi.fn() })).toBeNull();
  });

  it("does not cache failures: the next call retries", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(okFeed({ data: [{ id: "m", context_length: 100 }] }));
    await expect(fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl })).resolves.toBeNull();
    const retried = await fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl });
    expect(retried.ids).toEqual(["m"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("passes a timeout signal and no-store cache", async () => {
    let seenOptions;
    const fetchImpl = vi.fn(async (url, options) => {
      seenOptions = options;
      return okFeed({ data: [] });
    });
    await fetchLiveModelFeed({ url: URL, headers: HEADERS, fetchImpl, timeoutMs: 1234 });
    expect(seenOptions.cache).toBe("no-store");
    expect(seenOptions.signal).toBeInstanceOf(AbortSignal);
  });
});
