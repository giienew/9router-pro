"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Select, Toggle } from "@/shared/components";
import { MODEL_CAPS_OVERRIDE_META, MODEL_CAPS_OVERRIDE_NUMBER_KEYS, STT_TRANSPORT_META, STT_TRANSPORTS } from "@/shared/constants/models";

// Tri-state per capability: "auto" = use detection, "on"/"off" = explicit.
// The editor stores only the explicit fields (sparse override); "auto" never
// writes a key, so detection keeps working for everything the user leaves
// alone. Plain Toggle components cannot express "auto", hence Selects.
const TRI_STATE_OPTIONS = [
  { value: "auto", label: "Auto (detected)" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

const TOGGLE_KEYS = Object.keys(MODEL_CAPS_OVERRIDE_META).filter((k) => !MODEL_CAPS_OVERRIDE_NUMBER_KEYS.includes(k));

const defaultTriState = () => Object.fromEntries(TOGGLE_KEYS.map((key) => [key, "auto"]));
const defaultNumbers = () => Object.fromEntries(MODEL_CAPS_OVERRIDE_NUMBER_KEYS.map((key) => [key, ""]));

function triStateToSparse(triState, numbers) {
  const sparse = {};
  for (const key of TOGGLE_KEYS) {
    if (triState[key] === "on") sparse[key] = true;
    else if (triState[key] === "off") sparse[key] = false;
  }
  for (const key of MODEL_CAPS_OVERRIDE_NUMBER_KEYS) {
    const raw = String(numbers[key] ?? "").trim();
    if (raw !== "") sparse[key] = Number(raw);
  }
  return sparse;
}

function sparseToTriState(capsOverride) {
  const triState = defaultTriState();
  const numbers = defaultNumbers();
  if (capsOverride && typeof capsOverride === "object") {
    for (const key of TOGGLE_KEYS) {
      if (capsOverride[key] === true) triState[key] = "on";
      else if (capsOverride[key] === false) triState[key] = "off";
    }
    for (const key of MODEL_CAPS_OVERRIDE_NUMBER_KEYS) {
      if (Number.isInteger(capsOverride[key]) && capsOverride[key] > 0) numbers[key] = String(capsOverride[key]);
    }
  }
  return { triState, numbers };
}

function formatDetected(caps) {
  if (!caps) return "";
  const parts = [];
  if (caps.vision) parts.push("Vision");
  if (caps.search) parts.push("Web search");
  if (caps.reasoning) parts.push("Reasoning");
  const fmt = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
  if (Number.isFinite(caps.contextWindow)) parts.push(`${fmt(caps.contextWindow)} context`);
  if (Number.isFinite(caps.maxOutput)) parts.push(`${fmt(caps.maxOutput)} max output`);
  return parts.join(" · ") || "Text-only";
}

export default function AddCustomModelModal({ isOpen, providerAlias, providerDisplayAlias, onSave, onSaveEdit, onClose, initialModel, detectedCaps }) {
  const isEdit = !!initialModel;
  const [modelId, setModelId] = useState("");
  const [triState, setTriState] = useState(defaultTriState);
  const [numbers, setNumbers] = useState(defaultNumbers);
  const [numberError, setNumberError] = useState("");
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | "ok" | "error"
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);
  // Realtime dispatch marker for the transport select; "" = provider default REST.
  const [transport, setTransport] = useState("");
  // STT is a model TYPE, not a chat capability (add mode only; edits are llm).
  const [isStt, setIsStt] = useState(false);

  // Reset state when modal opens (edit mode pre-fills from the stored override)
  useEffect(() => {
    if (isOpen) {
      if (initialModel) {
        setModelId(initialModel.id || "");
        const { triState: t, numbers: n } = sparseToTriState(initialModel.capsOverride);
        setTriState(t);
        setNumbers(n);
      } else {
        setModelId("");
        setTriState(defaultTriState());
        setNumbers(defaultNumbers());
      }
      setTransport("");
      setIsStt(false);
      setNumberError("");
      setTestStatus(null);
      setTestError("");
    }
    // initialModel is read on open only: the parent holds it stable while
    // the modal is open, and re-running on its identity would wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Strip provider's own alias prefix (e.g. "cc/model" -> "model" for cc provider)
  const stripAlias = (id) => {
    const prefix = `${providerAlias}/`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  };

  const handleTest = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId) return;
    setTestStatus("testing");
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}` }),
      });
      const data = await res.json();
      setTestStatus(data.ok ? "ok" : "error");
      setTestError(data.error || "");
    } catch (err) {
      setTestStatus("error");
      setTestError(err.message);
    }
  };

  const validateNumbers = () => {
    for (const key of MODEL_CAPS_OVERRIDE_NUMBER_KEYS) {
      const raw = String(numbers[key] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        setNumberError(`${MODEL_CAPS_OVERRIDE_META[key].label} must be a positive whole number (empty = auto).`);
        return false;
      }
    }
    setNumberError("");
    return true;
  };

  const handleSave = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || saving) return;
    if (!validateNumbers()) return;
    const capsOverride = triStateToSparse(triState, numbers);
    setSaving(true);
    try {
      if (isEdit) {
        await onSaveEdit?.({ modelId: cleanId, capsOverride });
      } else {
        // Legacy `caps` is dual-written for the two boolean keys the old
        // add flow stored (vision/reasoning), so readers of the raw row keep
        // working; the sparse override is what the runtime actually applies.
        const legacyCaps = {};
        if (triState.vision !== "auto") legacyCaps.vision = triState.vision === "on";
        if (triState.reasoning !== "auto") legacyCaps.reasoning = triState.reasoning === "on";
        await onSave({ modelId: cleanId, capsOverride, legacyCaps, type: isStt ? "stt" : "llm", transport: isStt ? transport : null });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = () => {
    setTriState(defaultTriState());
    setNumbers(defaultNumbers());
    setNumberError("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleTest();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? "Edit Model" : "Add Custom Model"}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setTestStatus(null); setTestError(""); }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. claude-opus-4-5"
              disabled={isEdit}
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary disabled:opacity-60"
              autoFocus={!isEdit}
            />
            <Button
              variant="secondary"
              icon="science"
              loading={testStatus === "testing"}
              onClick={handleTest}
              disabled={!modelId.trim() || testStatus === "testing"}
            >
              {testStatus === "testing" ? "Testing..." : "Test"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Sent to provider as: <code className="font-mono bg-sidebar px-1 rounded">{stripAlias(modelId.trim()) || "model-id"}</code>
          </p>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <label className="text-sm font-medium block">Capabilities</label>
            {isEdit && (
              <button type="button" onClick={handleResetAll} className="text-xs text-primary hover:underline shrink-0">
                Reset all to Auto
              </button>
            )}
          </div>
          {isEdit && detectedCaps && (
            <p className="text-xs text-text-muted mb-2">
              Detected: {formatDetected(detectedCaps)}. Auto keeps the detected value.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TOGGLE_KEYS.map((key) => (
              <Select
                key={key}
                label={MODEL_CAPS_OVERRIDE_META[key].label}
                value={triState[key]}
                onChange={(e) => setTriState((prev) => ({ ...prev, [key]: e.target.value }))}
                options={TRI_STATE_OPTIONS}
                hint={MODEL_CAPS_OVERRIDE_META[key].desc}
              />
            ))}
            {MODEL_CAPS_OVERRIDE_NUMBER_KEYS.map((key) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-main">{MODEL_CAPS_OVERRIDE_META[key].label}</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={numbers[key]}
                  onChange={(e) => { setNumbers((prev) => ({ ...prev, [key]: e.target.value })); setNumberError(""); }}
                  placeholder={detectedCaps?.[key] ? `Auto (${detectedCaps[key].toLocaleString()})` : "Auto (detected)"}
                  className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40"
                />
                <p className="text-xs text-text-muted">{MODEL_CAPS_OVERRIDE_META[key].desc} — empty keeps the detected value.</p>
              </div>
            ))}
          </div>
          {numberError && (
            <p className="text-xs text-red-500 flex items-center gap-1 mt-2">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {numberError}
            </p>
          )}
        </div>

        {/* STT is a model TYPE, not a chat capability: the save flow turns this
            flag into type "stt" (the API honours a transport only on stt
            records). The select pins the realtime dispatch marker persisted
            with the model; the whitelist is the shared STT_TRANSPORT_META.
            Add mode only — edits are llm rows and keep their type. */}
        {!isEdit && (
          <div>
            <Toggle
              checked={isStt}
              onChange={(v) => { setIsStt(v); if (!v) setTransport(""); }}
              label="Speech to text"
              description="Transcribes audio via /v1/audio/transcriptions"
              size="sm"
            />
            {isStt && (
              <div className="mt-3">
                <Select
                  label="Transport"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value)}
                  placeholder="Provider default (REST)"
                  options={STT_TRANSPORTS.map((t) => ({ value: t, label: STT_TRANSPORT_META[t].label }))}
                  hint="Realtime transport marker for the STT dispatcher. Empty keeps the provider's REST format."
                />
              </div>
            )}
          </div>
        )}

        {/* Test result */}
        {testStatus === "ok" && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <span className="material-symbols-outlined text-base">check_circle</span>
            Model is reachable
          </div>
        )}
        {testStatus === "error" && (
          <div className="flex items-start gap-2 text-sm text-red-500">
            <span className="material-symbols-outlined text-base shrink-0">cancel</span>
            <span>{testError || "Model not reachable"}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
          <Button
            onClick={handleSave}
            fullWidth
            size="sm"
            disabled={!modelId.trim() || saving}
          >
            {saving ? "Saving..." : isEdit ? "Save" : "Add Model"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  onSave: PropTypes.func.isRequired,
  onSaveEdit: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  initialModel: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    capsOverride: PropTypes.object,
    type: PropTypes.string,
  }),
  detectedCaps: PropTypes.object,
};
