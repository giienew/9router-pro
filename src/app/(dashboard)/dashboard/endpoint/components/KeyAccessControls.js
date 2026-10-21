"use client";

// Per-API-key controls on the Endpoint page, kept behind a compact summary
// row so the key list stays scannable: one chip per control (access, token
// quota, rate limits), and a single inset editor panel when expanded.
// - "Restrict access": the key may call only the listed combos/models,
//   picked with the same shared ModelSelectModal the combo editor uses.
// - Token quota: per-key token budget over a rolling window.
// - Key limits: per-key rate caps for reselling (empty field = unlimited).
import { useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal } from "@/shared/components";

const QUOTA_WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

// 9Router Pro: per-key rate limits (for reselling). Empty field = unlimited.
const LIMIT_FIELDS_UI = [
  { field: "rpm", label: "Requests / min" },
  { field: "tpm", label: "Tokens / min" },
  { field: "rph", label: "Requests / hour" },
  { field: "rpd", label: "Requests / day" },
  { field: "maxConcurrent", label: "Max concurrent" },
];

const fmt = (n) => Number(n || 0).toLocaleString();

function limitsSummary(limits) {
  if (!limits) return null;
  const parts = [];
  if (limits.rpm) parts.push(`${limits.rpm}/min`);
  if (limits.tpm) parts.push(`${fmt(limits.tpm)} tok/min`);
  if (limits.rph) parts.push(`${fmt(limits.rph)}/hour`);
  if (limits.rpd) parts.push(`${fmt(limits.rpd)}/day`);
  if (limits.maxConcurrent) parts.push(`${limits.maxConcurrent} concurrent`);
  return parts.length ? parts.join(" · ") : null;
}

function GroupLabel({ children, right }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{children}</span>
      {right}
    </div>
  );
}

GroupLabel.propTypes = { children: PropTypes.node, right: PropTypes.node };

function Chip({ icon, children, tone = "muted" }) {
  const tones = {
    muted: "border-border-subtle text-text-muted",
    active: "border-primary/30 bg-primary/5 text-text-main",
    danger: "border-red-500/30 bg-red-500/5 text-red-500",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 ${tones[tone]}`}>
      <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>{icon}</span>
      <span className="whitespace-nowrap">{children}</span>
    </span>
  );
}

Chip.propTypes = { icon: PropTypes.string, children: PropTypes.node, tone: PropTypes.string };

export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict, onQuotaChange, onLimitsChange }) {
  const access = apiKey.access || { restricted: false, allow: [] };
  const quota = apiKey.quota || null;
  const quotaUsed = apiKey.quotaUsed || 0;
  const limits = apiKey.limits || null;
  const limitsUsage = apiKey.limitsUsage || null;

  const [open, setOpen] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const commitLimit = (field, rawValue) => {
    if (!onLimitsChange) return;
    const v = parseInt(rawValue, 10);
    const next = {
      rpm: limits?.rpm ?? null,
      tpm: limits?.tpm ?? null,
      rph: limits?.rph ?? null,
      rpd: limits?.rpd ?? null,
      maxConcurrent: limits?.maxConcurrent ?? null,
    };
    next[field] = Number.isFinite(v) && v > 0 ? v : null;
    onLimitsChange(next);
  };

  const openPicker = async () => {
    setPickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers?lite=1"), fetch("/api/models/alias")]);
      if (providersRes.ok) setActiveProviders((await providersRes.json()).connections || []);
      if (aliasRes.ok) setModelAliases((await aliasRes.json()).aliases || {});
    } catch (error) {
      console.log("Error loading picker data:", error);
    }
  };

  const setAllow = (allow) => onChange({ restricted: true, allow });
  const add = (model) => {
    const value = model?.value;
    if (value && !access.allow.some((e) => e.toLowerCase() === value.toLowerCase())) setAllow([...access.allow, value]);
  };
  const remove = (value) => setAllow(access.allow.filter((e) => e !== value));

  const quotaOver = !!quota?.enabled && quotaUsed >= quota.limit;
  const limitsText = limitsSummary(limits);

  return (
    <div className="mt-2" data-testid="key-access">
      {/* Summary row — always visible, keeps the key list scannable */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip icon={access.restricted ? "lock" : "lock_open"} tone={access.restricted ? "active" : "muted"}>
          {access.restricted ? `${access.allow.length} allowed` : "All models"}
        </Chip>
        <Chip icon="data_usage" tone={quotaOver ? "danger" : quota?.enabled ? "active" : "muted"}>
          {quota?.enabled ? `${fmt(quotaUsed)} / ${fmt(quota.limit)} tokens` : "No quota"}
        </Chip>
        <Chip icon="speed" tone={limitsText ? "active" : "muted"}>
          {limitsText || "No limits"}
        </Chip>
        <button
          onClick={() => setOpen(!open)}
          className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
          aria-expanded={open}
        >
          {open ? "Close" : "Settings"}
          <span
            className="material-symbols-outlined leading-none transition-transform"
            style={{ fontSize: "14px", transform: open ? "rotate(180deg)" : undefined }}
          >
            expand_more
          </span>
        </button>
      </div>

      {open && (
        <div className="mt-3 rounded-2xl border border-border-subtle bg-black/[0.02] p-4 dark:bg-white/[0.02]">
          {/* Access */}
          <GroupLabel
            right={
              <Toggle
                size="sm"
                checked={access.restricted}
                onChange={(checked) => (checked ? onRequestRestrict() : onChange({ restricted: false, allow: access.allow }))}
              />
            }
          >
            Restrict access
          </GroupLabel>
          {access.restricted ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {access.allow.length === 0 && (
                <span className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</span>
              )}
              {access.allow.map((entry) => (
                <span key={entry} className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2.5 pr-1.5 font-mono text-xs text-text-main">
                  {entry}
                  <button
                    onClick={() => remove(entry)}
                    className="rounded-full p-0.5 text-text-muted transition-colors hover:text-red-500"
                    title={`Remove ${entry}`}
                    aria-label={`Remove ${entry}`}
                  >
                    <span className="material-symbols-outlined block leading-none" style={{ fontSize: "12px" }}>close</span>
                  </button>
                </span>
              ))}
              <button
                onClick={openPicker}
                className="flex items-center gap-0.5 rounded-full border border-dashed border-black/15 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:border-primary/50 dark:border-white/15"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
                Add combo or model
              </button>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-text-muted">This key can call every combo and model.</p>
          )}

          {/* Token quota */}
          <div className="mt-4 border-t border-border-subtle pt-4">
            <GroupLabel
              right={
                <Toggle
                  size="sm"
                  checked={!!quota?.enabled}
                  onChange={(checked) => {
                    if (!onQuotaChange) return;
                    if (checked) {
                      const limit = parseInt(limitDraft, 10) || quota?.limit || 100000;
                      onQuotaChange({ enabled: true, limit, windowHours: quota?.windowHours || 24 });
                    } else if (quota) {
                      onQuotaChange({ ...quota, enabled: false });
                    }
                  }}
                />
              }
            >
              Token quota
            </GroupLabel>
            {!!quota?.enabled && (
              <div className="mt-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    className="w-32 rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                    defaultValue={quota.limit}
                    placeholder="100000"
                    onBlur={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (v > 0 && v !== quota.limit) onQuotaChange?.({ ...quota, limit: v });
                    }}
                    onChange={(e) => setLimitDraft(e.target.value)}
                  />
                  <span className="text-xs text-text-muted">tokens per</span>
                  <select
                    className="rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                    value={quota.windowHours}
                    onChange={(e) => onQuotaChange?.({ ...quota, windowHours: Number(e.target.value) })}
                  >
                    {QUOTA_WINDOWS.map((w) => (
                      <option key={w.hours} value={w.hours}>{w.label}</option>
                    ))}
                  </select>
                  <span className={`ml-auto text-xs tabular-nums ${quotaOver ? "font-medium text-red-500" : "text-text-muted"}`}>
                    {fmt(quotaUsed)} / {fmt(quota.limit)} used
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${quotaOver ? "bg-red-500" : "bg-brand-500"}`}
                    style={{ width: `${Math.min(100, quota.limit ? (quotaUsed / quota.limit) * 100 : 0)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Rate limits */}
          <div className="mt-4 border-t border-border-subtle pt-4">
            <GroupLabel
              right={
                limitsText ? (
                  <button
                    onClick={() => onLimitsChange?.(null)}
                    className="text-xs font-normal normal-case tracking-normal text-text-muted transition-colors hover:text-red-500"
                  >
                    Clear all
                  </button>
                ) : null
              }
            >
              Key limits
            </GroupLabel>
            <div key={JSON.stringify(limits)} className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {LIMIT_FIELDS_UI.map(({ field, label }) => (
                <label key={field} className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
                  <input
                    type="number"
                    min="1"
                    className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                    defaultValue={limits?.[field] ?? ""}
                    placeholder="Unlimited"
                    onBlur={(e) => commitLimit(field, e.target.value)}
                  />
                </label>
              ))}
            </div>
            {!!limitsUsage && (
              <p className="mt-2.5 flex items-center gap-1.5 text-[11px] tabular-nums text-text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Live: {limitsUsage.rpmUsed || 0} req/min
                {limits?.tpm ? ` · ${fmt(limitsUsage.tpmUsed)} tok/min` : ""}
                {limits?.rph ? ` · ${fmt(limitsUsage.rphUsed)} req/hour` : ""}
                {limits?.rpd ? ` · ${fmt(limitsUsage.rpdUsed)} req/day` : ""}
                {" · "}{limitsUsage.inFlight || 0} in flight
              </p>
            )}
          </div>
        </div>
      )}

      {pickerOpen && (
        <ModelSelectModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={add}
          onDeselect={(model) => remove(access.allow.find((e) => e.toLowerCase() === String(model?.value).toLowerCase()))}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Allowed for "${apiKey.name}"`}
          addedModelValues={access.allow}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

KeyAccessControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    access: PropTypes.shape({ restricted: PropTypes.bool, allow: PropTypes.arrayOf(PropTypes.string) }),
    quota: PropTypes.shape({ enabled: PropTypes.bool, limit: PropTypes.number, windowHours: PropTypes.number }),
    quotaUsed: PropTypes.number,
    limits: PropTypes.shape({
      rpm: PropTypes.number, tpm: PropTypes.number, rph: PropTypes.number,
      rpd: PropTypes.number, maxConcurrent: PropTypes.number,
    }),
    limitsUsage: PropTypes.shape({
      rpmUsed: PropTypes.number, rphUsed: PropTypes.number, rpdUsed: PropTypes.number,
      tpmUsed: PropTypes.number, inFlight: PropTypes.number,
    }),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
  onQuotaChange: PropTypes.func,
  onLimitsChange: PropTypes.func,
};
