// Structured webhook events (9Router Pro, P3-30 webhooks).
// Separate from the generic notification webhook in notify.js (which posts
// a plain-text alert for silent jobs): these are typed JSON events a
// receiver can route on — `usage`, `quota`, and `error`.
//
// Off by default, per event: the master webhook must be enabled AND the
// individual event flag must be on. Nothing is sent unless an operator
// turns both on in the notifications settings.
//
// Credential handling: credential-valued fields are NEVER sent raw.
// `maskCredentials` (default true) replaces them with "[masked]" so a
// receiver can still see that a credential was involved; with masking
// off, those fields are dropped from the payload entirely — they are
// never emitted unmasked. Raw API keys are never included at all: usage
// events carry only the masked key form (first 8 + "***" + last 4, the
// same form the usage-history API already exposes).
import { getNotifyConfig, signWebhook, NOTIFY_TIMEOUT_MS } from "./notify.js";

export const WEBHOOK_EVENT_TYPES = ["usage", "quota", "error"];

export function defaultWebhookEventsConfig() {
  return { usage: false, quota: false, error: false, maskCredentials: true };
}

export function normalizeWebhookEventsConfig(raw) {
  const base = defaultWebhookEventsConfig();
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    usage: r.usage === true,
    quota: r.quota === true,
    error: r.error === true,
    maskCredentials: r.maskCredentials !== false,
  };
}

// Keys whose values are credential material (or credential-adjacent) and
// must never reach a webhook receiver raw, whatever the masking flag says.
const SECRET_KEYS = new Set([
  "apiKey", "apikey", "api_key", "accessToken", "access_token", "refreshToken",
  "refresh_token", "idToken", "id_token", "secret", "token", "password",
  "botToken", "clientSecret", "sessionToken", "cookie", "authorization",
]);

export function maskApiKeyForWebhook(key) {
  if (!key || typeof key !== "string") return null;
  const t = key.trim();
  if (t.length <= 12) return `${t.charAt(0)}***`;
  return `${t.slice(0, 8)}***${t.slice(-4)}`;
}

// Deep-redact one payload: secret keys become "[masked]" (mask on) or
// are dropped (mask off); everything else passes through, capped in
// depth/size so a pathological payload cannot balloon a webhook POST.
export function redactWebhookData(value, maskCredentials = true, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactWebhookData(v, maskCredentials, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2000 ? value.slice(0, 2000) : value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) {
      if (maskCredentials) out[k] = "[masked]";
      continue;
    }
    out[k] = redactWebhookData(v, maskCredentials, depth + 1);
  }
  return out;
}

export function webhookEventEnabled(config, eventType) {
  if (!WEBHOOK_EVENT_TYPES.includes(eventType)) return false;
  const w = config?.webhook || {};
  if (w.enabled !== true || !w.url) return false;
  const events = normalizeWebhookEventsConfig(config?.webhookEvents);
  return events[eventType] === true;
}

// Config cache: usage events fire on the hot path, and a KV read per
// usage row would double its DB cost. A 30s cache (positive or negative)
// bounds that to one read per half-minute; toggling an event therefore
// takes effect within 30s. Tests inject `config` directly and skip this.
let cachedConfig = null;
let cachedAt = 0;
const CONFIG_TTL_MS = 30_000;
export function __resetWebhookEventCache() {
  cachedConfig = null;
  cachedAt = 0;
}
async function getCachedConfig() {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    cachedConfig = await getNotifyConfig();
  } catch {
    cachedConfig = null;
  }
  cachedAt = Date.now();
  return cachedConfig;
}

// Fire-and-forget: never throws, never blocks the request that produced
// the event. Returns "sent" | "skipped" | "failed" for tests/callers that
// await it; production callers deliberately do not await.
export async function emitWebhookEvent(eventType, data = {}, { config = null, fetchFn = null } = {}) {
  try {
    const cfg = config || (await getCachedConfig());
    if (!webhookEventEnabled(cfg, eventType)) return "skipped";
    const events = normalizeWebhookEventsConfig(cfg.webhookEvents);
    const payload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: redactWebhookData(data, events.maskCredentials),
    };
    const body = JSON.stringify(payload);
    const fn = fetchFn || fetch;
    const res = await fn(cfg.webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.webhook.secret ? { "X-9Router-Signature": signWebhook(cfg.webhook.secret, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "sent";
  } catch (e) {
    console.warn(`[WebhookEvents] ${eventType} failed: ${e?.message || e}`);
    return "failed";
  }
}

// Convenience wrappers so call sites read as the event they emit. None of
// them awaits the POST; the event must never slow a request down.
export function emitUsageWebhook(data, opts) {
  emitWebhookEvent("usage", data, opts).catch(() => {});
}
export function emitQuotaWebhook(data, opts) {
  emitWebhookEvent("quota", data, opts).catch(() => {});
}
export function emitErrorWebhook(data, opts) {
  emitWebhookEvent("error", data, opts).catch(() => {});
}
