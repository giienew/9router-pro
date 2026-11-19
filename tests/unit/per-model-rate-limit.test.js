// Per-model rate limit (pro.29 item D) — custom-provider limiter.
// Run from tests/:
//   ./node_modules/.bin/vitest run unit/per-model-rate-limit.test.js
import assert from "node:assert";
import {
  tryAcquirePerModelRateLimit,
  peekPerModelRateLimit,
  resolvePerModelRateLimit,
  resolvePerModelScope,
  isCustomProviderId,
  PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT,
  PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS,
  PER_MODEL_RATE_LIMIT_MAX_BUCKETS,
  __resetPerModelRateLimit,
  __perModelRateLimitBucketCount,
} from "../../src/lib/perModelRateLimit.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const PROVIDER = "openai-compatible-chat-11111111-1111-1111-1111-111111111111";
const T0 = 1_000_000;

beforeEach(() => {
  __resetPerModelRateLimit();
});

describe("resolvePerModelRateLimit (defaults + config)", () => {
  it("defaults to 120 requests per 60s, enabled, when no settings exist", () => {
    assert.deepEqual(resolvePerModelRateLimit(undefined, PROVIDER, "gpt-x"), {
      enabled: true,
      limit: PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT,
      windowMs: PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS,
    });
    assert.equal(PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT, 120);
    assert.equal(PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS, 60_000);
    assert.deepEqual(resolvePerModelRateLimit({}, PROVIDER, "gpt-x").limit, 120);
  });

  it("honours global, per-provider, and per-model overrides in that precedence order", () => {
    const settings = {
      perModelRateLimit: {
        limit: 10,
        windowMs: 30_000,
        overrides: {
          [PROVIDER]: { limit: 20 },
          [`${PROVIDER}/hot-model`]: { limit: 5, windowMs: 10_000 },
        },
      },
    };
    assert.deepEqual(resolvePerModelRateLimit(settings, PROVIDER, "other-model"), {
      enabled: true, limit: 20, windowMs: 30_000,
    });
    assert.deepEqual(resolvePerModelRateLimit(settings, PROVIDER, "hot-model"), {
      enabled: true, limit: 5, windowMs: 10_000,
    });
    assert.equal(resolvePerModelRateLimit(settings, "dahl", "deepseek").limit, 10);
  });

  it("enabled:false or limit:0 disables the limiter; values are clamped", () => {
    assert.equal(resolvePerModelRateLimit({ perModelRateLimit: { enabled: false } }, PROVIDER, "m").enabled, false);
    assert.equal(resolvePerModelRateLimit({ perModelRateLimit: { limit: 0 } }, PROVIDER, "m").enabled, false);
    assert.equal(resolvePerModelRateLimit({ perModelRateLimit: { limit: 999999 } }, PROVIDER, "m").limit, 10000);
    assert.equal(resolvePerModelRateLimit({ perModelRateLimit: { windowMs: 1 } }, PROVIDER, "m").windowMs, 1000);
    assert.equal(resolvePerModelRateLimit({ perModelRateLimit: { windowMs: 99_999_999 } }, PROVIDER, "m").windowMs, 3600_000);
  });
});

describe("isCustomProviderId", () => {
  it("matches user-created compatible nodes only, never registry providers", () => {
    assert.equal(isCustomProviderId("openai-compatible-chat-abc"), true);
    assert.equal(isCustomProviderId("openai-compatible-responses-abc"), true);
    assert.equal(isCustomProviderId("anthropic-compatible-abc"), true);
    assert.equal(isCustomProviderId("dahl"), false);
    assert.equal(isCustomProviderId("openai"), false);
    assert.equal(isCustomProviderId("deepai"), false);
    assert.equal(isCustomProviderId(null), false);
    assert.equal(isCustomProviderId(42), false);
  });
});

describe("resolvePerModelScope", () => {
  it("prefers a stable session id, then the API key, then a shared bucket", () => {
    assert.equal(resolvePerModelScope({ sessionId: "sess-1", apiKey: "sk-abc" }), "session:sess-1");
    assert.equal(resolvePerModelScope({ apiKey: "sk-abc" }), resolvePerModelScope({ apiKey: "sk-abc" }));
    assert.notEqual(resolvePerModelScope({ apiKey: "sk-abc" }), resolvePerModelScope({ apiKey: "sk-def" }));
    assert.equal(resolvePerModelScope({}), "shared");
    assert.equal(resolvePerModelScope(), "shared");
  });

  it("never puts the raw API key into the scope string", () => {
    const scope = resolvePerModelScope({ apiKey: "sk-live-secret-value-123" });
    assert.equal(scope.includes("sk-live-secret-value-123"), false);
    assert.equal(scope.startsWith("key:"), true);
  });
});

describe("tryAcquirePerModelRateLimit", () => {
  it("passes under the limit and counts each admitted request", () => {
    const opts = { provider: PROVIDER, model: "gpt-x", scope: "session:s1", limit: 3, windowMs: 60_000 };
    assert.deepEqual(tryAcquirePerModelRateLimit({ ...opts, now: T0 }), {
      allowed: true, used: 1, limit: 3, windowMs: 60_000, retryAfterSec: 0, resetAtMs: T0 + 60_000,
    });
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, now: T0 + 1 }).used, 2);
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, now: T0 + 2 }).used, 3);
  });

  it("blocks exactly at the limit, reports retry-after, and a blocked attempt consumes nothing", () => {
    const opts = { provider: PROVIDER, model: "gpt-x", scope: "session:s1", limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) tryAcquirePerModelRateLimit({ ...opts, now: T0 + i });
    const blocked = tryAcquirePerModelRateLimit({ ...opts, now: T0 + 3 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.used, 3);
    assert.equal(blocked.limit, 3);
    assert.equal(blocked.resetAtMs, T0 + 60_000);
    assert.equal(blocked.retryAfterSec, 60);
    // Still blocked (and still used=3) one second later: no consumption while blocked.
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, now: T0 + 4000 }).allowed, false);
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 + 4000 }).used, 3);
  });

  it("is per-model: a hot model does not block a different model on the same provider", () => {
    const base = { provider: PROVIDER, scope: "session:s1", limit: 2, windowMs: 60_000 };
    for (let i = 0; i < 2; i++) tryAcquirePerModelRateLimit({ ...base, model: "hot-model", now: T0 + i });
    assert.equal(tryAcquirePerModelRateLimit({ ...base, model: "hot-model", now: T0 + 2 }).allowed, false);
    assert.equal(tryAcquirePerModelRateLimit({ ...base, model: "cool-model", now: T0 + 2 }).allowed, true);
    // Same model name on a different provider is a different bucket too.
    assert.equal(tryAcquirePerModelRateLimit({ ...base, provider: "openai-compatible-chat-other", model: "hot-model", now: T0 + 2 }).allowed, true);
  });

  it("is per-scope: one session/customer hitting the cap does not block another", () => {
    const base = { provider: PROVIDER, model: "gpt-x", limit: 1, windowMs: 60_000 };
    assert.equal(tryAcquirePerModelRateLimit({ ...base, scope: "session:alice", now: T0 }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ ...base, scope: "session:alice", now: T0 + 1 }).allowed, false);
    assert.equal(tryAcquirePerModelRateLimit({ ...base, scope: "session:bob", now: T0 + 1 }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ ...base, scope: resolvePerModelScope({ apiKey: "sk-one" }), now: T0 + 1 }).allowed, true);
  });

  it("resets when the window slides past: old timestamps fall out, the model serves again", () => {
    const opts = { provider: PROVIDER, model: "gpt-x", scope: "session:s1", limit: 2, windowMs: 10_000 };
    tryAcquirePerModelRateLimit({ ...opts, now: T0 });
    tryAcquirePerModelRateLimit({ ...opts, now: T0 + 1000 });
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, now: T0 + 2000 }).allowed, false);
    // Oldest entry (T0) expires at T0+10000; one slot frees.
    const freed = tryAcquirePerModelRateLimit({ ...opts, now: T0 + 10_001 });
    assert.equal(freed.allowed, true);
    assert.equal(freed.used, 2);
    // Whole window past: back to a fresh count.
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, now: T0 + 30_000 }).used, 1);
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 + 30_000 }).used, 1);
  });

  it("peek reads without recording, and a zero/disabled limit fails open", () => {
    const opts = { provider: PROVIDER, model: "gpt-x", scope: "session:s1", limit: 2, windowMs: 60_000 };
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 }).used, 0);
    tryAcquirePerModelRateLimit({ ...opts, now: T0 });
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 }).used, 1);
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, limit: 0, now: T0 }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ ...opts, limit: -5, now: T0 }).allowed, true);
  });

  it("fails open on bad input instead of ever breaking chat", () => {
    assert.equal(tryAcquirePerModelRateLimit({ provider: "", model: "m" }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ provider: PROVIDER, model: null }).allowed, true);
    assert.equal(tryAcquirePerModelRateLimit().allowed, true);
    assert.equal(tryAcquirePerModelRateLimit({ provider: PROVIDER, model: "m", now: "not-a-time" }).allowed, true);
  });
});

describe("bounds", () => {
  it("caps the bucket map: creating more than MAX_BUCKETS buckets evicts the oldest", () => {
    const limit = 1;
    for (let i = 0; i < PER_MODEL_RATE_LIMIT_MAX_BUCKETS + 50; i++) {
      tryAcquirePerModelRateLimit({ provider: PROVIDER, model: `model-${i}`, scope: "session:s1", limit, windowMs: 60_000, now: T0 });
    }
    assert.ok(__perModelRateLimitBucketCount() <= PER_MODEL_RATE_LIMIT_MAX_BUCKETS);
    // The earliest bucket was evicted, so its model serves again (used resets).
    assert.equal(
      peekPerModelRateLimit({ provider: PROVIDER, model: "model-0", scope: "session:s1", limit, windowMs: 60_000, now: T0 }).used,
      0,
    );
  });

  it("caps the per-bucket timestamp ring at the limit (admission only while used < limit)", () => {
    const opts = { provider: PROVIDER, model: "gpt-x", scope: "session:s1", limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 20; i++) tryAcquirePerModelRateLimit({ ...opts, now: T0 + i });
    assert.equal(peekPerModelRateLimit({ ...opts, now: T0 + 20 }).used, 5);
  });
});

describe("combo failover for a rate-limited member", () => {
  it("a 429 (the hook's response) is a fallback error, so the combo tries the next member", () => {
    const verdict = checkFallbackError(429, "Per-model rate limit exceeded", 0, PROVIDER);
    assert.equal(verdict.shouldFallback, true);
  });
});
