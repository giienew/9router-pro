// Outbound notifications (9Router Pro): Telegram bot + generic webhook.
// One place for every outbound alert. Fail-open by design: a dead channel
// must never break the request or job that triggered the alert, and tokens
// are never logged or returned to the dashboard (see getNotifyStatus).
import { createHmac } from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const kv = makeKv("notifications");

export const NOTIFY_TIMEOUT_MS = 10000;

export function defaultNotifyConfig() {
  return {
    telegram: { enabled: false, botToken: "", chatId: "" },
    webhook: { enabled: false, url: "", secret: "" },
    // Structured webhook events (see webhookEvents.js): every event type
    // is off by default; masking is on by default (see that module for
    // the exact "mask on → [masked], mask off → dropped" semantics).
    webhookEvents: { usage: false, quota: false, error: false, maskCredentials: true },
  };
}

export function normalizeWebhookEvents(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    usage: r.usage === true,
    quota: r.quota === true,
    error: r.error === true,
    maskCredentials: r.maskCredentials !== false,
  };
}

export function normalizeNotifyConfig(raw) {
  const base = defaultNotifyConfig();
  const t = raw?.telegram || {};
  const w = raw?.webhook || {};
  return {
    telegram: {
      enabled: t.enabled === true,
      botToken: typeof t.botToken === "string" ? t.botToken.trim() : "",
      chatId: typeof t.chatId === "string" ? t.chatId.trim() : "",
    },
    webhook: {
      enabled: w.enabled === true,
      url: typeof w.url === "string" ? w.url.trim() : "",
      secret: typeof w.secret === "string" ? w.secret : "",
    },
    webhookEvents: normalizeWebhookEvents(raw?.webhookEvents),
  };
}

export async function getNotifyConfig() {
  try {
    return normalizeNotifyConfig(await kv.get("config", null));
  } catch {
    return defaultNotifyConfig();
  }
}

export async function saveNotifyConfig(raw) {
  const next = normalizeNotifyConfig(raw);
  await kv.set("config", next);
  return next;
}

// Masked view for the dashboard: flags + non-secret fields only.
export async function getNotifyStatus() {
  const cfg = await getNotifyConfig();
  return {
    telegram: {
      enabled: cfg.telegram.enabled,
      configured: Boolean(cfg.telegram.botToken && cfg.telegram.chatId),
      chatId: cfg.telegram.chatId,
    },
    webhook: {
      enabled: cfg.webhook.enabled,
      configured: Boolean(cfg.webhook.url),
      url: cfg.webhook.url,
    },
    webhookEvents: cfg.webhookEvents || defaultNotifyConfig().webhookEvents,
  };
}

export function buildNotifyText(event, data = {}) {
  const lines = [`[9Router Pro] ${event}`];
  if (data.title) lines.push(data.title);
  if (data.detail) lines.push(String(data.detail));
  if (data.model) lines.push(`model: ${data.model}`);
  if (data.keyName) lines.push(`key: ${data.keyName}`);
  if (data.error) lines.push(`error: ${String(data.error).slice(0, 300)}`);
  return lines.join("\n");
}

export function signWebhook(secret, body) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postJson(url, payload, headers, fetchFn) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// Sends to every enabled channel. Returns per-channel results; never throws.
// `config` and `fetchFn` are injectable for tests; production omits both.
export async function sendNotification(event, data = {}, { config = null, fetchFn = null } = {}) {
  const cfg = config || (await getNotifyConfig());
  const fn = fetchFn || fetch;
  const out = { telegram: "skipped", webhook: "skipped" };
  const text = buildNotifyText(event, data);

  if (cfg.telegram.enabled && cfg.telegram.botToken && cfg.telegram.chatId) {
    try {
      await postJson(
        `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`,
        { chat_id: cfg.telegram.chatId, text },
        {},
        fn,
      );
      out.telegram = "sent";
    } catch (e) {
      out.telegram = "failed";
      console.warn(`[Notify] telegram failed: ${e?.message || e}`);
    }
  }

  if (cfg.webhook.enabled && cfg.webhook.url) {
    try {
      const payload = { event, timestamp: new Date().toISOString(), data };
      const body = JSON.stringify(payload);
      const headers = cfg.webhook.secret
        ? { "X-9Router-Signature": signWebhook(cfg.webhook.secret, body) }
        : {};
      // Re-send the exact signed body instead of re-serializing.
      const res = await fn(cfg.webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.webhook = "sent";
    } catch (e) {
      out.webhook = "failed";
      console.warn(`[Notify] webhook failed: ${e?.message || e}`);
    }
  }

  return out;
}
