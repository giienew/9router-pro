"use client";

// Per-API-key access control on the Endpoint page.
// "Restrict access" toggle per key; when on, the key may call only the listed
// combos/models, shown as removable badges. Entries are picked with the same
// shared ModelSelectModal the combo editor uses (combos first, then models).
import { useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal } from "@/shared/components";

const QUOTA_WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict, onQuotaChange }) {
  const access = apiKey.access || { restricted: false, allow: [] };
  const quota = apiKey.quota || null;
  const quotaUsed = apiKey.quotaUsed || 0;
  const [limitDraft, setLimitDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const openPicker = async () => {
    setPickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers"), fetch("/api/models/alias")]);
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

  return (
    <div className="mt-2" data-testid="key-access">
      <Toggle
        size="sm"
        checked={access.restricted}
        label="Restrict access"
        onChange={(checked) => (checked ? onRequestRestrict() : onChange({ restricted: false, allow: access.allow }))}
      />
      {access.restricted && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {access.allow.length === 0 && (
            <span className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</span>
          )}
          {access.allow.map((entry) => (
            <span key={entry} className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main">
              {entry}
              <button
                onClick={() => remove(entry)}
                className="rounded text-text-muted hover:text-red-500"
                title={`Remove ${entry}`}
                aria-label={`Remove ${entry}`}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
              </button>
            </span>
          ))}
          <button
            onClick={openPicker}
            className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
            Add combo or model
          </button>
        </div>
      )}
      {/* 9Router Pro: per-key token quota */}
      <div className="mt-2.5 border-t border-border-subtle pt-2.5">
        <Toggle
          size="sm"
          checked={!!quota?.enabled}
          label="Token quota"
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
        {!!quota?.enabled && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min="1"
              className="w-32 rounded-lg border border-border bg-bg px-2 py-1 font-mono text-xs text-text-main outline-none focus:border-brand-500"
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
              className="rounded-lg border border-border bg-bg px-2 py-1 text-xs text-text-main outline-none focus:border-brand-500"
              value={quota.windowHours}
              onChange={(e) => onQuotaChange?.({ ...quota, windowHours: Number(e.target.value) })}
            >
              {QUOTA_WINDOWS.map((w) => (
                <option key={w.hours} value={w.hours}>{w.label}</option>
              ))}
            </select>
            <span className={`text-xs ${quotaUsed >= quota.limit ? "font-medium text-red-500" : "text-text-muted"}`}>
              {quotaUsed.toLocaleString()} / {quota.limit.toLocaleString()} used
            </span>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div
                className={`h-full rounded-full ${quotaUsed >= quota.limit ? "bg-red-500" : "bg-brand-500"}`}
                style={{ width: `${Math.min(100, quota.limit ? (quotaUsed / quota.limit) * 100 : 0)}%` }}
              />
            </div>
          </div>
        )}
      </div>
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
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
  onQuotaChange: PropTypes.func,
};
