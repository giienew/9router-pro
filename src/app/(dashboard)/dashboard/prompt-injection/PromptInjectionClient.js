"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Toggle from "@/shared/components/Toggle";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { InjectionTester } from "./InjectExtras";

const API = "/api/prompt-injection";

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function entryText(entry) {
  if (!entry) return "";
  if (entry.mode === "chat") return (entry.turns || []).map((t) => t.content).join("\n");
  return entry.content || "";
}

function nextRole(turns) {
  if (!turns.length) return "user";
  return turns[turns.length - 1].role === "user" ? "assistant" : "user";
}

// Clipboard with a fallback: navigator.clipboard is missing in insecure
// contexts and some webviews, where Copy used to just fail.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// One editor for one target. Two modes: a single system prompt, or a
// scripted chat whose turns are injected as fake history.
function InjectEditor({ initial, onSave, onClear, saving, clearLabel }) {
  const [mode, setMode] = useState(initial?.mode || "single");
  const [content, setContent] = useState(initial?.content || "");
  const [turns, setTurns] = useState(
    initial?.mode === "chat" && initial.turns?.length
      ? initial.turns
      : [
          { role: "user", content: "" },
          { role: "assistant", content: "" },
        ]
  );
  const [position, setPosition] = useState(initial?.position || "append");
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [emptyWarn, setEmptyWarn] = useState(false);

  useEffect(() => {
    setMode(initial?.mode || "single");
    setContent(initial?.content || "");
    if (initial?.mode === "chat" && initial.turns?.length) setTurns(initial.turns);
    setPosition(initial?.position || "append");
    setEnabled(initial?.enabled !== false);
  }, [initial]);

  const setTurn = (i, content) =>
    setTurns((ts) => ts.map((t, j) => (j === i ? { ...t, content } : t)));
  const removeTurn = (i) => setTurns((ts) => ts.filter((_, j) => j !== i));
  const addTurn = () => setTurns((ts) => [...ts, { role: nextRole(ts), content: "" }]);

  const text = mode === "chat" ? turns.map((t) => t.content).join("\n") : content;

  const save = () => {
    // An empty save is meaningless: the server treats an empty entry as
    // "no injection", so the old entry would silently vanish while the UI
    // claimed "saved". Block it here and say what to do instead.
    const isEmpty =
      mode === "chat" ? turns.every((t) => !t.content.trim()) : !content.trim();
    if (isEmpty) {
      setEmptyWarn(true);
      return;
    }
    setEmptyWarn(false);
    if (mode === "chat") {
      onSave({ mode: "chat", turns: turns.filter((t) => t.content.trim()), position, enabled });
    } else {
      onSave({ mode: "single", content, position, enabled });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border text-sm">
          <button
            type="button"
            onClick={() => setMode("single")}
            className={`px-3 py-1.5 font-medium transition-colors ${
              mode === "single" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
            }`}
          >
            Single prompt
          </button>
          <button
            type="button"
            onClick={() => setMode("chat")}
            className={`px-3 py-1.5 font-medium transition-colors ${
              mode === "chat" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
            }`}
          >
            Chat script
          </button>
        </div>
        <span className="ml-auto text-xs text-text-muted">~{estimateTokens(text)} tokens</span>
      </div>

      {mode === "single" ? (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={7}
            placeholder="Write the system prompt for this target…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed"
          />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {turns.map((t, i) => (
              <div key={i} className="flex items-start gap-2">
                <span
                  className={`mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    t.role === "user" ? "bg-surface-3 text-text-muted" : "bg-primary/15 text-primary"
                  }`}
                  title={t.role === "user" ? "Your message" : "Bot reply"}
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {t.role === "user" ? "person" : "smart_toy"}
                  </span>
                </span>
                <textarea
                  value={t.content}
                  onChange={(e) => setTurn(i, e.target.value)}
                  rows={3}
                  placeholder={t.role === "user" ? "Your message…" : "The bot's reply…"}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed"
                />
                <button
                  type="button"
                  onClick={() => removeTurn(i)}
                  title="Remove turn"
                  className="mt-2 shrink-0 text-text-muted transition-colors hover:text-red-500"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={addTurn}
              className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-primary hover:text-primary"
            >
              + Add {nextRole(turns) === "user" ? "your message" : "bot reply"}
            </button>
            <span className="text-xs text-text-muted">
              Injected as a conversation that already happened, right before the real chat.
              Ending with a Bot reply keeps the roles alternating cleanly.
            </span>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {mode === "single" && (
          <div className="flex overflow-hidden rounded-lg border border-border text-sm">
            <button
              type="button"
              onClick={() => setPosition("append")}
              className={`px-3 py-1.5 font-medium transition-colors ${
                position === "append" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              Append
            </button>
            <button
              type="button"
              onClick={() => setPosition("prepend")}
              className={`px-3 py-1.5 font-medium transition-colors ${
                position === "prepend" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              Prepend
            </button>
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-primary)]"
          />
          Enabled
        </label>
        <div className="ml-auto flex gap-2">
          {onClear && (
            <Button variant="dangerOutline" size="sm" onClick={onClear} disabled={saving}>
              {clearLabel || "Clear"}
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {emptyWarn && (
        <p className="text-xs font-medium text-red-500">
          Write a prompt first — or use {clearLabel || "Clear"} to remove this injection.
        </p>
      )}
    </div>
  );
}

function SectionTitle({ icon, title, children }) {
  return (
    <div className="mb-1">
      <h2 className="flex items-center gap-2 text-base font-semibold uppercase tracking-wide">
        <span className="material-symbols-outlined text-primary">{icon}</span>
        {title}
      </h2>
      {children && <p className="mt-1 text-sm text-text-muted">{children}</p>}
    </div>
  );
}

function EntryBadge({ entry }) {
  if (!entry) return null;
  return (
    <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-text-muted">
      {entry.mode === "chat" ? `Chat · ${entry.turns?.length || 0} turns` : "Single prompt"}
      {entry.enabled === false ? " · off" : ""}
    </span>
  );
}

const actionBtnClass =
  "flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5";

// Destructive action with a two-tap confirm: first tap arms it ("Sure?")
// for 3 seconds, second tap actually deletes. No modal, no surprises.
function ConfirmButton({ label, icon, onConfirm }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <button
        type="button"
        onClick={onConfirm}
        className="flex items-center gap-1 rounded-md bg-red-500 px-2 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600"
      >
        <span className="material-symbols-outlined text-[16px]">warning</span>
        Sure?
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      title={`Delete — tap twice to confirm`}
      className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      {label}
    </button>
  );
}

// Marks a target name as one of the user's combos, so it's obvious the
// "model" here can be a combo name — the name a client calls, not a raw
// provider model.
function ComboChip() {
  return (
    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
      combo
    </span>
  );
}

function targetSummary(preset) {
  const parts = [];
  if (preset.targets?.global) parts.push("Global");
  const m = preset.targets?.models?.length || 0;
  const k = preset.targets?.keys?.length || 0;
  if (m) parts.push(`${m} model${m === 1 ? "" : "s"}`);
  if (k) parts.push(`${k} key${k === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No targets yet";
}

function PresetCard({ preset, onToggle, onCopy, onEdit, onDuplicate, onDelete }) {
  return (
    <Card padding="sm" className={preset.enabled === false ? "opacity-60" : ""}>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <span className="material-symbols-outlined text-[18px] text-primary">bookmarks</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-semibold">{preset.name}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
              <EntryBadge entry={preset} />
              <span>{targetSummary(preset)}</span>
              <span>~{estimateTokens(entryText(preset))} tokens</span>
            </div>
          </div>
          <Toggle
            checked={preset.enabled !== false}
            onChange={onToggle}
            aria-label={`Enable preset ${preset.name}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 pl-11">
          <button type="button" onClick={onCopy} title="Copy preset name" className={actionBtnClass}>
            <span className="material-symbols-outlined text-[16px]">content_copy</span>
            Copy
          </button>
          <button type="button" onClick={onEdit} title="Edit preset" className={actionBtnClass}>
            <span className="material-symbols-outlined text-[16px]">edit</span>
            Edit
          </button>
          <button type="button" onClick={onDuplicate} title="Duplicate preset" className={actionBtnClass}>
            <span className="material-symbols-outlined text-[16px]">library_add</span>
            Duplicate
          </button>
          <ConfirmButton label="Delete" icon="delete" onConfirm={onDelete} />
        </div>
      </div>
    </Card>
  );
}

// Preset editor: name + auto-loaded target checklists + the shared
// InjectEditor for the prompt itself (its Save saves the whole preset).
function PresetModal({ preset, keys, keyName, modelOptions, comboNames = [], onClose, onSave, saving }) {
  const isNew = !preset?.id;
  const [name, setName] = useState(preset?.name || "");
  const [tGlobal, setTGlobal] = useState(!!preset?.targets?.global);
  const [tModels, setTModels] = useState(preset?.targets?.models || []);
  const [tKeys, setTKeys] = useState(preset?.targets?.keys || []);
  const [modelQuery, setModelQuery] = useState("");

  const toggleIn = (list, setList, v) =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const visibleModels = modelOptions.filter(
    (m) => !modelQuery.trim() || m.toLowerCase().includes(modelQuery.trim().toLowerCase())
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isNew ? "New preset" : "Edit preset"}
      size="lg"
      bodyClassName="p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Persona — Friendly"
        />

        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            Targets
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              loaded automatically
            </span>
          </p>

          <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
            <span className="flex items-center gap-2 text-sm">
              <span className="material-symbols-outlined text-[18px] text-text-muted">public</span>
              Global — every request
            </span>
            <Toggle checked={tGlobal} onChange={setTGlobal} aria-label="Target all requests" />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">
                Models · {tModels.length} selected
              </span>
              <span className="flex gap-2 text-[11px] font-medium">
                <button type="button" onClick={() => setTModels(modelOptions)} className="text-primary hover:underline">
                  Select all
                </button>
                <button type="button" onClick={() => setTModels([])} className="text-text-muted hover:underline">
                  Clear
                </button>
              </span>
            </div>
            <input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            />
            <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-border">
              {visibleModels.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">No models match.</p>
              ) : (
                visibleModels.map((m) => (
                  <label
                    key={m}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={tModels.includes(m)}
                      onChange={() => toggleIn(tModels, setTModels, m)}
                      className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                    />
                    <span className="min-w-0 truncate font-mono">{m}</span>
                    {comboNames.includes(m) && <ComboChip />}
                  </label>
                ))
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-text-muted">
              Combo names work too — a preset on a combo covers every request that calls
              that combo, e.g. from a Hermes config or another combo.
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-text-muted">
              API keys · {tKeys.length} selected
            </p>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-border">
              {keys.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">No API keys yet.</p>
              ) : (
                keys.map((k) => (
                  <label
                    key={k.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={tKeys.includes(k.id)}
                      onChange={() => toggleIn(tKeys, setTKeys, k.id)}
                      className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                    />
                    <span className="min-w-0 truncate">{keyName(k.id)}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-border-subtle pt-4">
          <InjectEditor
            key={preset?.id || "new"}
            initial={preset || null}
            saving={saving}
            onSave={(fields) =>
              onSave({
                id: preset?.id,
                name: name.trim(),
                ...fields,
                targets: { global: tGlobal, models: tModels, keys: tKeys },
              })
            }
          />
        </div>
      </div>
    </Modal>
  );
}

// Model Edit panel: the target name is a field here (not a separate
// Rename action) — change it and Save renames the injection.
function ModelEditPanel({ name, entry, isCombo, saving, onSave, onClear }) {
  const [draftName, setDraftName] = useState(name);
  const trimmed = draftName.trim();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">
          Name — the name clients call (Hermes model / combo name)
        </label>
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]"
        />
        {trimmed && trimmed !== name && (
          <p className="mt-1 text-[11px] text-text-muted">
            Saving moves this injection to the new name — clients must call the new name to receive it.
            {isCombo ? " The combo itself keeps its own name." : ""}
          </p>
        )}
      </div>
      <InjectEditor
        initial={entry}
        saving={saving}
        onSave={(fields) => onSave(trimmed, fields)}
        onClear={onClear}
        clearLabel="Delete"
      />
    </div>
  );
}

export default function PromptInjectionClient() {
  const [msg, setMsg] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((text, type = "success") => {
    setMsg({ text, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  const [loading, setLoading] = useState(true);
  const [global_, setGlobal] = useState(null);
  const [userPrompts, setUserPrompts] = useState({});
  const [prompts, setPrompts] = useState({});
  const [presets, setPresets] = useState([]);
  const [keys, setKeys] = useState([]);
  const [modelOptions, setModelOptions] = useState([]);
  const [comboNames, setComboNames] = useState([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [newModel, setNewModel] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [saving, setSaving] = useState("");
  const [editingPreset, setEditingPreset] = useState(undefined); // undefined=closed, null=new
  const [globalOpen, setGlobalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState(null);

  const load = useCallback(async () => {
    try {
      const [injRes, keyRes, modelsRes, combosRes] = await Promise.all([
        fetch(API),
        fetch("/api/keys"),
        fetch("/api/models"),
        fetch("/api/combos"),
      ]);
      const inj = await injRes.json();
      setGlobal(inj.global || null);
      setUserPrompts(inj.userPrompts || {});
      setPrompts(inj.prompts || {});
      setPresets(Array.isArray(inj.presets) ? inj.presets : []);
      const keyData = await keyRes.json();
      const list = Array.isArray(keyData?.keys) ? keyData.keys : Array.isArray(keyData) ? keyData : [];
      setKeys(list);
      // Callable model names, auto-loaded: combos + routed provider models,
      // plus anything already targeted so nothing ever looks lost.
      const names = new Set();
      try {
        const modelsData = await modelsRes.json();
        for (const m of modelsData?.models || []) {
          if (m.routedModel) names.add(m.routedModel);
          if (m.fullModel) names.add(m.fullModel);
        }
      } catch { /* models list is a convenience, not a requirement */ }
      try {
        const combosData = await combosRes.json();
        const combos = (combosData?.combos || []).filter((c) => c && c.name);
        setComboNames(combos.map((c) => c.name));
        for (const c of combos) names.add(c.name);
      } catch { /* same */ }
      for (const name of Object.keys(inj.prompts || {})) names.add(name);
      for (const p of inj.presets || []) for (const m of p.targets?.models || []) names.add(m);
      setModelOptions([...names].sort());
    } catch {
      showToast("Failed to load prompt injections", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const put = async (payload, tag, okMsg) => {
    setSaving(tag);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("save failed");
      showToast(okMsg, "success");
      await load();
      return true;
    } catch {
      showToast("Failed to save", "error");
      return false;
    } finally {
      setSaving("");
    }
  };

  const del = async (qs, tag, okMsg) => {
    setSaving(tag);
    try {
      const res = await fetch(`${API}?${qs}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      showToast(okMsg, "success");
      await load();
    } catch {
      showToast("Failed to delete", "error");
    } finally {
      setSaving("");
    }
  };

  const savePreset = async (payload) => {
    if (!payload.name) {
      showToast("Preset name is required", "error");
      return;
    }
    const ok = await put({ preset: payload }, "preset", "Preset saved");
    if (ok) setEditingPreset(undefined);
  };

  const copyName = async (name, okMsg = "Name copied — paste it into your Hermes config or a combo") => {
    if (await copyText(name)) {
      showToast(okMsg, "success");
    } else {
      showToast("Copy failed", "error");
    }
  };

  // Save from the model Edit panel: the name is a field in that panel, so
  // a changed name renames the injection — save under the new name, then
  // delete the old one. Refuses to overwrite a name that already has an
  // injection.
  const saveModelEntry = async (oldName, newName, entry) => {
    if (!newName) {
      showToast("Name can't be empty", "error");
      return;
    }
    if (newName !== oldName && prompts[newName]) {
      showToast("That name already has an injection", "error");
      return;
    }
    if (newName === oldName) {
      await put({ model: oldName, ...entry }, `model-${oldName}`, "Model injection saved");
      return;
    }
    setSaving(`model-${oldName}`);
    try {
      const r1 = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newName, ...entry }),
      });
      if (!r1.ok) throw new Error("rename failed");
      const r2 = await fetch(`${API}?model=${encodeURIComponent(oldName)}`, { method: "DELETE" });
      if (!r2.ok) throw new Error("rename failed");
      showToast(`Renamed to ${newName} and saved`, "success");
      setEditingModel(null);
      await load();
    } catch {
      showToast("Failed to save", "error");
    } finally {
      setSaving("");
    }
  };

  const keyName = (id) => keys.find((k) => k.id === id)?.name || id;
  const selectedKeyEntry = selectedKeyId ? userPrompts[selectedKeyId] || null : null;
  const modelNames = Object.keys(prompts).sort();

  // ---- Import / Export (Pro) ----
  const exportInjections = async () => {
    try {
      const res = await fetch(API);
      const data = await res.json();
      const blob = new Blob(
        [JSON.stringify({ app: "9router-pro", kind: "prompt-injections", version: 1, ...data }, null, 2)],
        { type: "application/json" }
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "prompt-injections.json";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      showToast("Export failed", "error");
    }
  };

  const importInjections = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      let applied = 0;
      let skipped = 0;
      if (data.global) {
        const res = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ global: data.global }),
        });
        if (res.ok) applied++; else skipped++;
      }
      for (const preset of data.presets || []) {
        const res = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset }),
        });
        if (res.ok) applied++; else skipped++;
      }
      for (const [model, entry] of Object.entries(data.prompts || {})) {
        const res = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, ...entry }),
        });
        if (res.ok) applied++; else skipped++;
      }
      for (const [keyId, entry] of Object.entries(data.userPrompts || {})) {
        if (!keys.some((k) => k.id === keyId)) { skipped++; continue; }
        const res = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyId, ...entry }),
        });
        if (res.ok) applied++; else skipped++;
      }
      showToast(`Imported ${applied} injection(s)${skipped ? `, ${skipped} skipped` : ""}`, "success");
      await load();
    } catch {
      showToast("Import failed — not a valid injections file", "error");
    }
  };

  // ---- Stack Preview (Pro) — re-runs automatically on any change ----
  const [pvModel, setPvModel] = useState("");
  const [pvKeyId, setPvKeyId] = useState("");
  const [pvStack, setPvStack] = useState(null);
  const runPreview = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ preview: "1", model: pvModel, keyId: pvKeyId });
      const res = await fetch(`${API}?${qs}`);
      const data = await res.json();
      setPvStack(data.stack || []);
    } catch {
      showToast("Preview failed", "error");
    }
  }, [pvModel, pvKeyId, showToast]);

  useEffect(() => {
    if (loading) return;
    const t = setTimeout(runPreview, 400);
    return () => clearTimeout(t);
  }, [runPreview, loading, global_, userPrompts, prompts, presets]);

  const globalEditorOpen = globalOpen || !global_;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span className="material-symbols-outlined text-primary">skull</span>
            Prompt Injection
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Presets and direct injections — stacked global → user → model.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportInjections}>
            <span className="material-symbols-outlined text-[16px]">download</span> Export
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-2">
            <span className="material-symbols-outlined text-[16px]">upload</span> Import
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) importInjections(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </label>
          <Button size="sm" icon="add" onClick={() => setEditingPreset(null)}>
            New Preset
          </Button>
        </div>
      </div>
      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.type === "error" ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"}`}>
          {msg.text}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle icon="bookmarks" title="Presets">
              Write once, target anywhere. A preset fires ahead of the direct entry in its
              scope — and only once per request, at the first scope it matches.
            </SectionTitle>
            {presets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center">
                <span className="material-symbols-outlined text-[28px] text-text-muted">bookmarks</span>
                <p className="text-sm text-text-muted">
                  No presets yet — create one to reuse the same prompt across models and keys.
                </p>
                <Button size="sm" icon="add" onClick={() => setEditingPreset(null)}>
                  Create preset
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {presets.map((p) => (
                  <PresetCard
                    key={p.id}
                    preset={p}
                    onToggle={(v) => put({ preset: { ...p, enabled: v } }, `preset-${p.id}`, v ? "Preset enabled" : "Preset disabled")}
                    onCopy={() => copyName(p.name, "Preset name copied")}
                    onEdit={() => setEditingPreset(p)}
                    onDuplicate={() =>
                      put(
                        { preset: { ...p, id: "", name: `${p.name} copy` } },
                        `preset-${p.id}`,
                        "Preset duplicated"
                      )
                    }
                    onDelete={() => del(`presetId=${encodeURIComponent(p.id)}`, `preset-${p.id}`, "Preset deleted")}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="public" title="Global injection">
              Applies to every chat request, whatever the model or key.
            </SectionTitle>
            <Card>
              {global_ && !globalEditorOpen ? (
                <div className="flex flex-wrap items-center gap-2">
                  <EntryBadge entry={global_} />
                  <span className="text-xs text-text-muted">
                    ~{estimateTokens(entryText(global_))} tokens
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">
                    {entryText(global_).split("\n")[0]}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setGlobalOpen(true)}>
                    Edit
                  </Button>
                </div>
              ) : (
                <>
                  {global_ && (
                    <div className="mb-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setGlobalOpen(false)}
                        className="text-xs font-medium text-text-muted hover:text-text-main"
                      >
                        Collapse
                      </button>
                    </div>
                  )}
                  <InjectEditor
                    key={`global-${global_?.updatedAt || "new"}`}
                    initial={global_}
                    saving={saving === "global"}
                    onSave={(entry) => put({ global: entry }, "global", "Global injection saved")}
                    onClear={global_ ? () => put({ global: {} }, "global", "Global injection cleared") : undefined}
                    clearLabel="Clear"
                  />
                </>
              )}
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="key" title="User injections — per API key">
              Whoever calls with that key gets this injection, on any model.
            </SectionTitle>
            <div className="flex flex-col gap-2">
              {Object.keys(userPrompts).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedKeyId(id)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selectedKeyId === id ? "border-primary bg-primary/5" : "border-border hover:bg-surface-2"
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px] text-text-muted">key</span>
                  <span className="font-medium">{keyName(id)}</span>
                  <span className="ml-auto"><EntryBadge entry={userPrompts[id]} /></span>
                </button>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <span className="text-text-muted">Key:</span>
                <select
                  value={selectedKeyId}
                  onChange={(e) => setSelectedKeyId(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2"
                >
                  <option value="">— select a key —</option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name || k.id}{userPrompts[k.id] ? " · has injection" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedKeyId && (
              <Card>
                <InjectEditor
                  key={`key-${selectedKeyId}-${selectedKeyEntry?.updatedAt || "new"}`}
                  initial={selectedKeyEntry}
                  saving={saving === `key-${selectedKeyId}`}
                  onSave={(entry) =>
                    put({ keyId: selectedKeyId, ...entry }, `key-${selectedKeyId}`, "User injection saved")
                  }
                  onClear={
                    selectedKeyEntry
                      ? () => del(`keyId=${encodeURIComponent(selectedKeyId)}`, `key-${selectedKeyId}`, "User injection deleted")
                      : undefined
                  }
                  clearLabel="Delete"
                />
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="smart_toy" title="Model injections">
              Matched by the name the client calls, then the resolved provider/model.
            </SectionTitle>
            <div className="flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-text-muted">
              <p>
                <span className="font-semibold text-text-main">The name is the model your client sends.</span>{" "}
                Combo names count too — every request that calls the combo gets this injection.
              </p>
              <p>
                <span className="font-semibold text-text-main">Hermes:</span> use this name as
                the model in the Hermes config (or switch with{" "}
                <code className="font-mono text-primary">/model</code>) — done, it applies automatically.
              </p>
              <p>
                <span className="font-semibold text-text-main">Combos:</span> a member called
                through its combo uses the combo&apos;s injection; called directly, it uses its own.
              </p>
            </div>
            <div className="flex gap-2">
              <input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="model or combo name — e.g. my-assistant"
                list="pi-model-names"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]"
              />
              <datalist id="pi-model-names">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowModelPicker(true)}
                className="shrink-0 whitespace-nowrap"
              >
                Browse models
              </Button>
            </div>
            {newModel.trim() && !prompts[newModel.trim()] && (
              <Card>
                <p className="mb-3 font-mono text-[13px] text-primary">{newModel.trim()}</p>
                <InjectEditor
                  key={`newmodel-${newModel.trim()}`}
                  initial={null}
                  saving={saving === `model-${newModel.trim()}`}
                  onSave={(entry) =>
                    put({ model: newModel.trim(), ...entry }, `model-${newModel.trim()}`, "Model injection saved")
                  }
                />
              </Card>
            )}
            <div className="flex flex-col gap-2">
              {modelNames.map((name) => (
                <Card key={name} padding="sm">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 break-all font-mono text-[13px] text-primary">{name}</p>
                      {comboNames.includes(name) && <ComboChip />}
                    </div>
                    {comboNames.includes(name) && (
                      <div className="text-[11px]">
                        <Link href="/dashboard/combos" className="font-medium text-primary hover:underline">
                          This is a combo — open it
                        </Link>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      <EntryBadge entry={prompts[name]} />
                      <span className="text-xs text-text-muted">
                        ~{estimateTokens(entryText(prompts[name]))} tokens
                      </span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => copyName(name)}
                        title="Copy name"
                        className={actionBtnClass}
                      >
                        <span className="material-symbols-outlined text-[16px]">content_copy</span>
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingModel(editingModel === name ? null : name)}
                        title="Edit"
                        className={actionBtnClass}
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {editingModel === name ? "expand_less" : "edit"}
                        </span>
                        Edit
                      </button>
                      <ConfirmButton
                        label="Delete"
                        icon="delete"
                        onConfirm={() => del(`model=${encodeURIComponent(name)}`, `model-${name}`, "Model injection deleted")}
                      />
                    </div>
                  </div>
                  {editingModel === name && (
                    <div className="mt-3 border-t border-border-subtle pt-3">
                      <ModelEditPanel
                        key={`${name}-${prompts[name]?.updatedAt || ""}`}
                        name={name}
                        entry={prompts[name]}
                        isCombo={comboNames.includes(name)}
                        saving={saving === `model-${name}`}
                        onSave={(newName, entry) => saveModelEntry(name, newName, entry)}
                        onClear={() => del(`model=${encodeURIComponent(name)}`, `model-${name}`, "Model injection deleted")}
                      />
                    </div>
                  )}
                </Card>
              ))}
              {modelNames.length === 0 && (
                <p className="text-sm text-text-muted">No model injections yet — add one above.</p>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="layers" title="Stack preview">
              Exactly what one request receives, in order — updates automatically.
            </SectionTitle>
            <Card>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={pvModel}
                    onChange={(e) => setPvModel(e.target.value)}
                    placeholder="model or combo name — e.g. my-assistant"
                    list="pi-model-names"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]"
                  />
                  <select
                    value={pvKeyId}
                    onChange={(e) => setPvKeyId(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <option value="">— no key —</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>{k.name || k.id}</option>
                    ))}
                  </select>
                </div>
                {pvStack !== null && (
                  pvStack.length === 0 ? (
                    <p className="text-sm text-text-muted">No injections would fire for this combination.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {pvStack.map((item, i) => (
                        <div key={i} className="rounded-lg border border-border bg-surface p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-xs font-bold uppercase tracking-wider text-primary">
                              {i + 1}. {item.name}
                            </span>
                            <EntryBadge entry={item.mode === "chat" ? { mode: "chat", turns: item.turns } : { mode: "single" }} />
                            {item.mode === "single" && (
                              <span className="text-xs text-text-muted">
                                {item.position} · ~{estimateTokens(item.text)} tokens
                              </span>
                            )}
                          </div>
                          {item.mode === "single" ? (
                            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-text-muted">{item.text}</pre>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {item.turns.map((t, j) => (
                                <div key={j} className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                                  t.role === "user" ? "self-start bg-surface-3" : "self-end bg-primary/10"
                                }`}>
                                  <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-text-muted">
                                    {t.role === "user" ? "You" : "Bot"}
                                  </span>
                                  <span className="whitespace-pre-wrap">{t.content}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="science" title="Injection tester">
              Same probe, two models — see what the injection changes.
            </SectionTitle>
            <Card>
              <InjectionTester />
            </Card>
          </section>

          <p className="text-center text-xs text-text-muted">
            Tip: one strong injection beats a pile of small ones.{" "}
            <Link href="/dashboard/token-saver" className="underline">Token Saver</Link>{" "}
            handles compression; this page handles persona.
          </p>
        </>
      )}

      {editingPreset !== undefined && (
        <PresetModal
          preset={editingPreset}
          keys={keys}
          keyName={keyName}
          modelOptions={modelOptions}
          comboNames={comboNames}
          onClose={() => setEditingPreset(undefined)}
          onSave={savePreset}
          saving={saving === "preset"}
        />
      )}

      <ModelSelectModal
        isOpen={showModelPicker}
        onClose={() => setShowModelPicker(false)}
        onSelect={(m) => setNewModel(m.value || m.id || "")}
      />
    </div>
  );
}
