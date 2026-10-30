import { describe, it, expect, vi } from "vitest";
import {
  normalizeWebhookEventsConfig,
  redactWebhookData,
  webhookEventEnabled,
  emitWebhookEvent,
  maskApiKeyForWebhook,
} from "../../src/lib/webhookEvents.js";

const baseConfig = {
  webhook: { enabled: true, url: "https://example.test/hook", secret: "s3cr3t" },
  webhookEvents: { usage: true, quota: false, error: true, maskCredentials: true },
};

describe("webhook events config", () => {
  it("defaults every event off and masking on", () => {
    expect(normalizeWebhookEventsConfig(undefined)).toEqual({
      usage: false, quota: false, error: false, maskCredentials: true,
    });
    expect(normalizeWebhookEventsConfig({})).toEqual({
      usage: false, quota: false, error: false, maskCredentials: true,
    });
  });
  it("requires the master webhook on, a URL, and the per-event flag", () => {
    expect(webhookEventEnabled(baseConfig, "usage")).toBe(true);
    expect(webhookEventEnabled(baseConfig, "quota")).toBe(false);
    expect(webhookEventEnabled({ ...baseConfig, webhook: { enabled: false, url: "https://example.test/hook" } }, "usage")).toBe(false);
    expect(webhookEventEnabled(baseConfig, "nope")).toBe(false);
  });
});

describe("redactWebhookData", () => {
  it("masks credential fields when masking is on", () => {
    const out = redactWebhookData({ apiKey: "sk-live-123", nested: { accessToken: "tok" }, model: "dahl/m" }, true);
    expect(out).toEqual({ apiKey: "[masked]", nested: { accessToken: "[masked]" }, model: "dahl/m" });
  });
  it("drops credential fields entirely when masking is off — never raw", () => {
    const out = redactWebhookData({ apiKey: "sk-live-123", model: "dahl/m" }, false);
    expect(out).toEqual({ model: "dahl/m" });
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
  });
  it("masks keys without ever echoing the raw value", () => {
    expect(maskApiKeyForWebhook("sk-abcdefghijklmnop")).toBe("sk-abcde***mnop");
    expect(maskApiKeyForWebhook("sk-abcdefghijklmnop")).not.toContain("fghijkl");
  });
});

describe("emitWebhookEvent", () => {
  it("sends a signed payload for an enabled event", async () => {
    const calls = [];
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const out = await emitWebhookEvent("usage", { provider: "dahl", apiKey: "sk-live-123" }, { config: baseConfig, fetchFn });
    expect(out).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe("https://example.test/hook");
    expect(opts.headers["X-9Router-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(opts.body);
    expect(body.event).toBe("usage");
    expect(body.data.apiKey).toBe("[masked]");
    expect(opts.body).not.toContain("sk-live-123");
  });
  it("skips disabled events without calling fetch", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const out = await emitWebhookEvent("quota", {}, { config: baseConfig, fetchFn });
    expect(out).toBe("skipped");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("never throws on a dead endpoint", async () => {
    const out = await emitWebhookEvent("error", { status: 502 }, {
      config: baseConfig,
      fetchFn: async () => { throw new Error("down"); },
    });
    expect(out).toBe("failed");
  });
});
