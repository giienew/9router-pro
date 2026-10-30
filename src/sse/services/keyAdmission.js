// Shared per-key admission for every modality handler (9Router Pro).
// Before, only the chat handler enforced rate limits and the token budget;
// a restricted key could bypass both through embeddings, images, TTS, STT,
// search, fetch, video, or systemone. Every handler now enters through
// withKeyAdmission(), which runs the same checks and releases the
// concurrency slot when the response (or its stream) ends.
//
// Fail-open throughout: an admission lookup error never blocks a request.
// A limiter outage must not take the API down. The one hard rule is a
// key that is actually over its configured limit: that gets a 429.
//
// Accrual boundary (G9): every modality now persists a usage row, so
// the token/cost budget sums recorded spend for chat, embeddings, image,
// systemone, TTS (estimated), STT (estimated), search (cost-only) and
// fetch (cost-only). The remaining disclosed gaps move no quota: video
// (async job, billed on completion, no usage at acceptance), streaming
// image generations whose adapter reports no usage, and any modality row
// marked accrual "request-only" in usageHistory meta. Rate limits
// (rpm/rph/rpd/concurrency) are in-memory and apply to every modality
// regardless.
import { getApiKeyByKey, checkKeyQuota, getKeyLimits, getKeyUsageInWindow, isKeyExpired } from "@/lib/localDb";
import { peekKeyLimits, admitKeyRequest } from "@/lib/keyRateLimiter.js";
import { extractApiKey } from "./auth.js";
import { errorResponse } from "open-sse/utils/error.js";
import * as log from "../utils/logger.js";
import { emitQuotaWebhook } from "@/lib/webhookEvents.js";

const LIMIT_MESSAGES = {
  rpm: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last minute)`,
  rph: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last hour)`,
  rpd: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last 24 hours)`,
  concurrency: (v) => `API key concurrency limit exceeded (${v.limit} requests already in flight)`,
};

// Returns { response } when the key is blocked, { release, keyRecord,
// rawKey, hasQuota } when admitted, or null when there is no key, no key
// record, or no configured limits/quota (proceed, nothing to release).
// Never throws.
export async function admitKey(request) {
  try {
    const rawKey = extractApiKey(request);
    if (!rawKey) return null;
    const keyRecord = await getApiKeyByKey(rawKey);
    if (!keyRecord) return null;
    // Per-key policy (P3-26): expiry is fail-CLOSED, unlike quota/limit
    // lookups. An expired key gets a 401 here, before any limit or quota
    // check, on every modality (all handlers enter through this function).
    if (isKeyExpired(keyRecord.expiresAt)) {
      log.warn("AUTH", `Key "${keyRecord.name}" expired at ${keyRecord.expiresAt}`);
      return { response: errorResponse(401, "API key expired") };
    }
    let release = null;
    const limits = await getKeyLimits(keyRecord.id);
    if (limits) {
      if (limits.tpm) {
        const tpmUsed = await getKeyUsageInWindow(rawKey, 1 / 60);
        if (tpmUsed >= limits.tpm) {
          log.warn("LIMIT", `Key "${keyRecord.name}" over TPM (${tpmUsed}/${limits.tpm})`);
          return { response: errorResponse(429, `API key rate limit exceeded (${tpmUsed}/${limits.tpm} tokens in the last minute)`, { "Retry-After": "60" }) };
        }
      }
      const verdict = peekKeyLimits(keyRecord.id, limits);
      if (verdict.blocked) {
        log.warn("LIMIT", `Key "${keyRecord.name}" over ${verdict.kind} (${verdict.used}/${verdict.limit})`);
        return { response: errorResponse(429, LIMIT_MESSAGES[verdict.kind](verdict), { "Retry-After": String(verdict.retryAfterSec) }) };
      }
      release = admitKeyRequest(keyRecord.id);
    }
    const quota = await checkKeyQuota(keyRecord.id, rawKey);
    if (quota.blocked) {
      // Structured webhook event (P3-30): quota exceeded, off by default.
      // The key value itself is never sent — only its dashboard name.
      emitQuotaWebhook({
        keyName: keyRecord.name,
        used: quota.used ?? null,
        limit: quota.quota?.limit ?? null,
        windowHours: quota.quota?.windowHours ?? null,
        costBlocked: quota.costBlocked === true,
        costUsed: quota.costUsed ?? null,
        costLimit: quota.quota?.costLimit ?? null,
      });
      if (release) release();
      if (quota.costBlocked) {
        log.warn("QUOTA", `Key "${keyRecord.name}" over cost quota ($${quota.costUsed}/${quota.quota.costLimit} in the last ${quota.quota.windowHours}h)`);
        return { response: errorResponse(429, `API key cost quota exceeded ($${quota.costUsed}/$${quota.quota.costLimit} in the last ${quota.quota.windowHours}h)`) };
      }
      log.warn("QUOTA", `Key "${keyRecord.name}" over quota (${quota.used}/${quota.quota.limit})`);
      return { response: errorResponse(429, `API key token quota exceeded (${quota.used}/${quota.quota.limit} tokens in the last ${quota.quota.windowHours}h)`) };
    }
    return { release, keyRecord, rawKey, hasQuota: !!quota.quota };
  } catch {
    return null;
  }
}

// Completion re-check (fire-and-forget, best-effort): a long streaming
// response can cross the budget mid-stream, after the entry pre-check.
// The usage write races stream delivery, so this log is visibility, not
// enforcement — the next request's pre-check is what actually blocks.
export function recheckKeyQuotaAfterCompletion(admission) {
  if (!admission?.hasQuota) return;
  checkKeyQuota(admission.keyRecord.id, admission.rawKey).then((verdict) => {
    if (verdict.blocked) {
      log.warn("QUOTA", `Key "${admission.keyRecord.name}" crossed quota during request (${verdict.used}/${verdict.quota.limit})`);
      emitQuotaWebhook({
        keyName: admission.keyRecord.name,
        used: verdict.used ?? null,
        limit: verdict.quota?.limit ?? null,
        windowHours: verdict.quota?.windowHours ?? null,
        costBlocked: verdict.costBlocked === true,
        crossedMidRequest: true,
      });
    }
  }).catch(() => {});
}

function wrapResponseWithRelease(response, release, onFinish) {
  if (!response || !response.body || typeof response.body.pipeThrough !== "function") {
    release();
    if (onFinish) onFinish();
    return response;
  }
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      release();
      if (onFinish) onFinish();
    }
  };
  try {
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush() { finish(); },
      cancel() { finish(); },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    finish();
    return response;
  }
}

// Run fn() under admission. onComplete(admission) fires when the response
// is fully produced (immediately for non-streaming, at stream end for
// streaming) and only for keys that actually have a quota configured.
export async function withKeyAdmission(request, fn, onComplete) {
  let admission = null;
  try {
    admission = await admitKey(request);
  } catch {
    admission = null;
  }
  if (admission?.response) return admission.response;
  const release = admission?.release || null;
  const finish = () => {
    if (admission?.hasQuota && onComplete) onComplete(admission);
  };
  let response;
  try {
    response = await fn();
  } catch (err) {
    if (release) release();
    throw err;
  }
  const streaming = response?.body && typeof response.body.pipeThrough === "function";
  if (release || (admission?.hasQuota && streaming)) {
    return wrapResponseWithRelease(response, release || (() => {}), finish);
  }
  finish();
  return response;
}
