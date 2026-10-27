import { describe, it, expect, vi } from "vitest";
import { buildNotifyText, signWebhook, sendNotification, defaultNotifyConfig } from "@/lib/notify.js";

describe("notifications", () => {
  it("builds a plain-text message without secrets", () => {
    const text = buildNotifyText("backup", { title: "Scheduled backup completed", detail: "snapshot abc" });
    expect(text).toContain("Scheduled backup completed");
    expect(text).toContain("snapshot abc");
  });

  it("signs webhooks deterministically (64 hex chars)", () => {
    const a = signWebhook("secret", '{"event":"test"}');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhook("secret", '{"event":"test"}')).toBe(a);
    expect(signWebhook("other", '{"event":"test"}')).not.toBe(a);
  });

  it("sends to enabled channels with the right payloads", async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    });
    const config = {
      ...defaultNotifyConfig(),
      telegram: { enabled: true, botToken: "tok123", chatId: "chat9" },
      webhook: { enabled: true, url: "https://example.test/hook", secret: "s3cr3t" },
    };
    const out = await sendNotification("test", { title: "hello" }, { config, fetchFn });
    expect(out).toEqual({ telegram: "sent", webhook: "sent" });
    const tg = calls.find((c) => c.url.includes("api.telegram.org"));
    expect(tg.url).toContain("bot" + "tok123");
    expect(JSON.parse(tg.opts.body).chat_id).toBe("chat9");
    const wh = calls.find((c) => c.url === "https://example.test/hook");
    expect(wh.opts.headers["X-9Router-Signature"]).toBe(signWebhook("s3cr3t", wh.opts.body));
    expect(JSON.parse(wh.opts.body).event).toBe("test");
  });

  it("skips disabled channels and never throws on channel failure", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("down"); });
    const config = {
      ...defaultNotifyConfig(),
      telegram: { enabled: true, botToken: "t", chatId: "c" },
      webhook: { enabled: false, url: "", secret: "" },
    };
    const out = await sendNotification("test", {}, { config, fetchFn });
    expect(out).toEqual({ telegram: "failed", webhook: "skipped" });
  });
});
