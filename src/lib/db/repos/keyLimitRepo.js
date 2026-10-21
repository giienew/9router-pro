// Key Limits (9Router Pro) — per-API-key rate limits for reselling:
// requests per minute/hour/day, tokens per minute and max concurrent
// requests. Config lives in KV; RPM/RPH/RPD/concurrency are enforced by the
// in-memory limiter (src/lib/keyRateLimiter.js), TPM by a soft DB pre-check
// in the chat handler reusing the quota's usage sum. A null field means
// "no limit"; a config with every field null is stored as no config at all.
//
//   scope "keyLimits": key = api key id,
//   value = { rpm, tpm, rph, rpd, maxConcurrent }

import { makeKv } from "../helpers/kvStore.js";

const limitsKv = makeKv("keyLimits");

export const LIMIT_FIELDS = ["rpm", "tpm", "rph", "rpd", "maxConcurrent"];
export const LIMIT_CAPS = { rpm: 1000000, tpm: 2000000000, rph: 10000000, rpd: 100000000, maxConcurrent: 10000 };

export function cleanKeyLimits(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  let any = false;
  for (const field of LIMIT_FIELDS) {
    const v = Math.floor(Number(raw[field]));
    if (Number.isFinite(v) && v > 0) {
      out[field] = Math.min(v, LIMIT_CAPS[field]);
      any = true;
    } else {
      out[field] = null;
    }
  }
  return any ? out : null;
}

export async function getKeyLimits(keyId) {
  if (!keyId) return null;
  return cleanKeyLimits(await limitsKv.get(keyId));
}

export async function getAllKeyLimits() {
  const all = (await limitsKv.getAll?.()) || {};
  const out = {};
  for (const [id, raw] of Object.entries(all)) {
    const l = cleanKeyLimits(raw);
    if (l) out[id] = l;
  }
  return out;
}

export async function setKeyLimits(keyId, limits) {
  const clean = cleanKeyLimits(limits);
  if (!clean) {
    await limitsKv.remove(keyId);
    return null;
  }
  await limitsKv.set(keyId, clean);
  return clean;
}

export async function deleteKeyLimits(keyId) {
  await limitsKv.remove(keyId);
}
