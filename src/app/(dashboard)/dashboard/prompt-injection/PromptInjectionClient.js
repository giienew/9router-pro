"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
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

// One editor for one prompt. Two modes: a single system prompt, or a
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
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={7}
          placeholder="Write the system prompt…"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed"
        />
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

function SectionTitle({ icon, title, children, action }) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2">
        <h2 className="flex flex-1 items-center gap-2 text-base font-semibold uppercase tracking-wide">
          <span className="material-symbols-outlined text-primary">{icon}</span>
          {title}
        </h2>
        {action}
      </div>
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
      title="Delete — tap twice to confirm"
      className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      {label}
    </button>
  );
}

// ------------------------------------------------------------ templates

function TemplateCard({ template, copiedId, onCopy, onEdit, onDelete }) {
  const isCopied = copiedId === `tpl:${template.id}`;
  return (
    <Card padding="sm">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 break-words text-sm font-semibold">{template.name}</p>
          <EntryBadge entry={template} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-text-muted">
            ~{estimateTokens(entryText(template))} tokens
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCopy}
            title="Copy prompt text"
            className={`${actionBtnClass} ${isCopied ? "text-emerald-500 hover:text-emerald-500" : ""}`}
          >
            <span className="material-symbols-outlined text-[16px]">{isCopied ? "check" : "content_copy"}</span>
            {isCopied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={onEdit} title="Edit template" className={actionBtnClass}>
            <span className="material-symbols-outlined text-[16px]">edit</span>
            Edit
          </button>
          <ConfirmButton label="Delete" icon="delete" onConfirm={onDelete} />
        </div>
      </div>
    </Card>
  );
}

// Template editor: a name + the prompt itself. Nothing else — a template
// is library content, not a live setting.
function TemplateModal({ template, onClose, onSave, saving }) {
  const isNew = !template?.id;
  const [name, setName] = useState(template?.name || "");
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isNew ? "New template" : "Edit template"}
      size="lg"
      bodyClassName="p-4 sm:p-6"
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Template name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Persona — Friendly"
        />
        <InjectEditor
          key={template?.id || "new"}
          initial={template || null}
          saving={saving}
          onSave={(fields) => onSave({ id: template?.id, name: name.trim(), ...fields })}
        />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ injections
// One coordinate = one injection. A coordinate is a scope (global, or a
// model name) optionally narrowed to one API key.

function coordId(c) {
  if (c.scope === "global") return c.keyId ? `key:${c.keyId}` : "global";
  return c.keyId ? `km:${c.keyId}::${c.model}` : `model:${c.model}`;
}

// The shared create/edit form: target coordinate on top, the prompt
// editor below. In create mode the prompt can start from a template.
function InjectionForm({
  initialCoord,
  entryAt,
  keys,
  keyName,
  templates,
  allowTemplateSource,
  saving,
  onSave,
  onClear,
}) {
  const [scope, setScope] = useState(initialCoord.scope);
  const [model, setModel] = useState(initialCoord.model || "");
  const [keyId, setKeyId] = useState(initialCoord.keyId || "");
  const [source, setSource] = useState("new"); // new | template
  const [templateId, setTemplateId] = useState("");
  const [customized, setCustomized] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const template = templates.find((t) => t.id === templateId) || null;
  const fromTemplate = allowTemplateSource && source === "template" && template;

  const submitEntry = (fields) =>
    onSave(
      { scope, model: model.trim(), keyId },
      fromTemplate ? { ...fields, templateName: template.name } : fields
    );
  // The editor always shows the entry that already lives at the chosen
  // coordinate — picking a target is also how you edit it.
  const currentEntry = entryAt ? entryAt({ scope, model: model.trim(), keyId }) : null;
  const editorInitial = fromTemplate
    ? { ...template, enabled: true }
    : currentEntry;
  const editorKey = fromTemplate
    ? `tpl-${template.id}`
    : `coord-${coordId({ scope, model: model.trim(), keyId })}-${currentEntry?.updatedAt || "new"}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Target</span>
          <div className="flex overflow-hidden rounded-lg border border-border text-sm">
            <button
              type="button"
              onClick={() => setScope("model")}
              className={`px-3 py-2 font-medium transition-colors ${
                scope === "model" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              Model
            </button>
            <button
              type="button"
              onClick={() => setScope("global")}
              className={`px-3 py-2 font-medium transition-colors ${
                scope === "global" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              Global
            </button>
          </div>
        </div>
        {scope === "model" && (
          <div className="flex min-w-0 flex-1 gap-2">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model or combo name — e.g. my-assistant"
              list="pi-model-names"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]"
            />
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} className="shrink-0 self-center whitespace-nowrap">
              Browse
            </Button>
          </div>
        )}
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 sm:max-w-[240px]">
          <span className="text-xs font-medium text-text-muted">API key (optional)</span>
          <select
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="">All keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>{keyName(k.id)}</option>
            ))}
          </select>
        </label>
      </div>

      {allowTemplateSource && templates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border text-sm">
            <button
              type="button"
              onClick={() => setSource("new")}
              className={`px-3 py-1.5 font-medium transition-colors ${
                source === "new" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              New prompt
            </button>
            <button
              type="button"
              onClick={() => setSource("template")}
              className={`px-3 py-1.5 font-medium transition-colors ${
                source === "template" ? "bg-primary text-white" : "bg-surface text-text-muted hover:text-text-main"
              }`}
            >
              From template
            </button>
          </div>
          {source === "template" && (
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setCustomized(false);
              }}
              className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm sm:w-auto sm:flex-1 sm:max-w-[280px]"
            >
              <option value="">— choose a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {allowTemplateSource && source === "template" && !template ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-text-muted">
          Choose a template above — its prompt is used exactly as saved.
        </p>
      ) : fromTemplate && !customized ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <EntryBadge entry={template} />
              <span className="text-xs text-text-muted">
                ~{estimateTokens(entryText(template))} tokens
                {template.mode !== "chat" ? ` · ${template.position}` : ""}
              </span>
            </div>
            {template.mode === "chat" ? (
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {(template.turns || []).map((t, i) => (
                  <p key={i} className="line-clamp-2 text-[13px] leading-relaxed text-text-muted">
                    <span className="font-semibold text-text-main">{t.role === "user" ? "You" : "Bot"}:</span>{" "}
                    {t.content}
                  </p>
                ))}
              </div>
            ) : (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-text-muted">
                {template.content}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted">Used exactly as saved in the template.</span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setCustomized(true)}>
                Customize
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() =>
                  submitEntry(
                    template.mode === "chat"
                      ? { mode: "chat", turns: template.turns, position: template.position, enabled: true }
                      : { mode: "single", content: template.content, position: template.position, enabled: true }
                  )
                }
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {fromTemplate && (
            <p className="text-xs text-text-muted">
              Your customized copy — the template itself stays unchanged.
            </p>
          )}
          <InjectEditor
            key={editorKey}
            initial={editorInitial}
            saving={saving}
            onSave={submitEntry}
            onClear={onClear}
            clearLabel="Delete"
          />
        </>
      )}
      <ModelSelectModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(m) => {
          setModel(m.value || m.id || "");
          setPickerOpen(false);
        }}
        title="Select model"
      />
    </div>
  );
}

// ------------------------------------------------------------ page

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
  const [keyModelPrompts, setKeyModelPrompts] = useState({});
  const [templates, setTemplates] = useState([]);
  const [keys, setKeys] = useState([]);
  const [modelOptions, setModelOptions] = useState([]);
  const [saving, setSaving] = useState("");
  const [editingTemplate, setEditingTemplate] = useState(undefined); // undefined=closed, null=new
  const [editingCoordId, setEditingCoordId] = useState(null);
  const [createSaving, setCreateSaving] = useState(false);

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
      setKeyModelPrompts(inj.keyModelPrompts || {});
      setTemplates(Array.isArray(inj.templates) ? inj.templates : []);
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
        for (const c of combos) names.add(c.name);
      } catch { /* same */ }
      for (const name of Object.keys(inj.prompts || {})) names.add(name);
      for (const models of Object.values(inj.keyModelPrompts || {})) {
        for (const name of Object.keys(models || {})) names.add(name);
      }
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

  const keyName = useCallback(
    (id) => keys.find((k) => k.id === id)?.name || id,
    [keys]
  );

  // ---- coordinates ----
  const entryAt = useCallback(
    (coord) => {
      if (!coord) return null;
      if (coord.scope === "global") {
        return coord.keyId ? userPrompts[coord.keyId] || null : global_;
      }
      if (!coord.model) return null;
      return coord.keyId
        ? keyModelPrompts[coord.keyId]?.[coord.model] || null
        : prompts[coord.model] || null;
    },
    [global_, userPrompts, prompts, keyModelPrompts]
  );

  const putCoord = (coord, fields) => {
    if (coord.scope === "global") {
      if (coord.keyId) return { payload: { keyId: coord.keyId, ...fields } };
      return { payload: { global: fields } };
    }
    if (coord.keyId) return { payload: { keyId: coord.keyId, model: coord.model, ...fields } };
    return { payload: { model: coord.model, ...fields } };
  };

  const deleteCoord = async (coord) => {
    if (coord.scope === "global" && !coord.keyId) {
      await put({ global: {} }, "global", "Injection deleted");
      return;
    }
    if (coord.scope === "global") {
      await del(`keyId=${encodeURIComponent(coord.keyId)}`, coordId(coord), "Injection deleted");
      return;
    }
    if (coord.keyId) {
      await del(
        `keyId=${encodeURIComponent(coord.keyId)}&model=${encodeURIComponent(coord.model)}`,
        coordId(coord),
        "Injection deleted"
      );
      return;
    }
    await del(`model=${encodeURIComponent(coord.model)}`, coordId(coord), "Injection deleted");
  };

  // Save an injection at a coordinate. When editing and the coordinate
  // changed, the entry moves: write the new coordinate, delete the old —
  // and refuse to land on a coordinate that already has an injection.
  const saveInjection = async (fromCoord, toCoord, fields) => {
    if (toCoord.scope === "model" && !toCoord.model) {
      showToast("Model name is required — or switch the target to Global", "error");
      return;
    }
    const fromId = fromCoord ? coordId(fromCoord) : null;
    const toId = coordId(toCoord);
    const moving = fromCoord && fromId !== toId;
    if (moving && entryAt(toCoord)) {
      showToast("That target already has an injection — edit it instead", "error");
      return;
    }
    if (!moving) {
      const { payload } = putCoord(toCoord, fields);
      const ok = await put(payload, toId, "Injection saved");
      if (ok && fromCoord) setEditingCoordId(null);
      return;
    }
    setSaving(fromId);
    try {
      const { payload } = putCoord(toCoord, fields);
      const r1 = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r1.ok) throw new Error("move failed");
      // Delete the old coordinate directly (no toast of its own).
      if (fromCoord.scope === "global" && !fromCoord.keyId) {
        await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ global: {} }),
        });
      } else {
        const qs =
          fromCoord.scope === "global"
            ? `keyId=${encodeURIComponent(fromCoord.keyId)}`
            : fromCoord.keyId
              ? `keyId=${encodeURIComponent(fromCoord.keyId)}&model=${encodeURIComponent(fromCoord.model)}`
              : `model=${encodeURIComponent(fromCoord.model)}`;
        await fetch(`${API}?${qs}`, { method: "DELETE" });
      }
      showToast("Injection saved", "success");
      setEditingCoordId(null);
      await load();
    } catch {
      showToast("Failed to save", "error");
    } finally {
      setSaving("");
    }
  };

  // Unified rows in stack order: global → key → model → model+key.
  const rows = [];
  if (global_) rows.push({ coord: { scope: "global" }, entry: global_ });
  for (const keyId of Object.keys(userPrompts).sort((a, b) => keyName(a).localeCompare(keyName(b)))) {
    rows.push({ coord: { scope: "global", keyId }, entry: userPrompts[keyId] });
  }
  for (const model of Object.keys(prompts).sort()) {
    rows.push({ coord: { scope: "model", model }, entry: prompts[model] });
  }
  for (const keyId of Object.keys(keyModelPrompts).sort((a, b) => keyName(a).localeCompare(keyName(b)))) {
    for (const model of Object.keys(keyModelPrompts[keyId]).sort()) {
      rows.push({ coord: { scope: "model", model, keyId }, entry: keyModelPrompts[keyId][model] });
    }
  }

  const saveTemplate = async (payload) => {
    if (!payload.name) {
      showToast("Template name is required", "error");
      return;
    }
    const ok = await put({ template: payload }, "template", "Template saved");
    if (ok) setEditingTemplate(undefined);
  };

  // Copy feedback follows the base app: the button itself flips to a
  // check + "Copied" for 2s (useCopyToClipboard), right where you tapped.
  const { copied, copy: copyWithFeedback } = useCopyToClipboard(2000);
  const copyName = (name) => copyWithFeedback(name, `name:${name}`);
  const copyPrompt = (entry, id) => copyWithFeedback(entryText(entry), id);

  // ---- Import / Export ----
  const exportInjections = async () => {
    try {
      const res = await fetch(API);
      const data = await res.json();
      const blob = new Blob(
        [JSON.stringify({ app: "9router-pro", kind: "prompt-injections", version: 2, ...data }, null, 2)],
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
      const send = async (payload) => {
        const res = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) applied++; else skipped++;
      };
      if (data.global) await send({ global: data.global });
      // Legacy files call templates "presets" — both are accepted.
      for (const template of data.templates || data.presets || []) {
        const { targets, ...rest } = template || {};
        await send({ template: rest });
      }
      for (const [model, entry] of Object.entries(data.prompts || {})) {
        await send({ model, ...entry });
      }
      for (const [keyId, entry] of Object.entries(data.userPrompts || {})) {
        if (!keys.some((k) => k.id === keyId)) { skipped++; continue; }
        await send({ keyId, ...entry });
      }
      for (const [keyId, models] of Object.entries(data.keyModelPrompts || {})) {
        if (!keys.some((k) => k.id === keyId)) { skipped++; continue; }
        for (const [model, entry] of Object.entries(models || {})) {
          await send({ keyId, model, ...entry });
        }
      }
      showToast(`Imported ${applied} item(s)${skipped ? `, ${skipped} skipped` : ""}`, "success");
      await load();
    } catch {
      showToast("Import failed — not a valid injections file", "error");
    }
  };

  // ---- Stack Preview — re-runs automatically on any change ----
  const [pvModel, setPvModel] = useState("");
  const [pvKeyId, setPvKeyId] = useState("");
  const [pvStack, setPvStack] = useState(null);
  const [pvPickerOpen, setPvPickerOpen] = useState(false);
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
  }, [runPreview, loading, global_, userPrompts, prompts, keyModelPrompts]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <span className="material-symbols-outlined text-primary">skull</span>
            Prompt Injection
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Templates, injections, and proof — stacked Global → Key → Model → Model + Key.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" icon="download" onClick={exportInjections}>
            Export
          </Button>
          <label className="inline-flex h-7 cursor-pointer items-center justify-center gap-2 rounded-[8px] border border-border px-3 text-xs font-semibold text-text-main transition-all duration-150 hover:border-brand-500/40 hover:bg-surface-2 active:scale-[0.97]">
            <span className="material-symbols-outlined text-[18px]">upload</span> Import
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
        </div>
      </div>
      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.type === "error" ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"}`}>
          {msg.text}
        </p>
      )}

      <datalist id="pi-model-names">
        {modelOptions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle
              icon="bookmarks"
              title="Templates"
              action={
                <Button size="sm" icon="add" onClick={() => setEditingTemplate(null)}>
                  New template
                </Button>
              }
            >
              A library of reusable prompts. A template never fires on its own — use one
              when creating an injection and its content is copied in.
            </SectionTitle>
            {templates.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center">
                <span className="material-symbols-outlined text-[28px] text-text-muted">bookmarks</span>
                <p className="text-sm text-text-muted">
                  No templates yet — save a prompt you reuse, then apply it anywhere in one pick.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    copiedId={copied}
                    onCopy={() => copyPrompt(t, `tpl:${t.id}`)}
                    onEdit={() => setEditingTemplate(t)}
                    onDelete={() => del(`templateId=${encodeURIComponent(t.id)}`, `template-${t.id}`, "Template deleted")}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="vaccines" title="Injections">
              One prompt per target — a model name or Global, optionally for one API key only.
              The name is what your client sends (Hermes model, <code className="font-mono text-primary">/model</code>, a combo name).
            </SectionTitle>
            <Card>
              <p className="mb-3 text-sm font-semibold">New injection</p>
              <InjectionForm
                initialCoord={{ scope: "model", model: "", keyId: "" }}
                entryAt={entryAt}
                keys={keys}
                keyName={keyName}
                templates={templates}
                allowTemplateSource
                saving={createSaving}
                onSave={async (coord, fields) => {
                  setCreateSaving(true);
                  try {
                    await saveInjection(null, coord, fields);
                  } finally {
                    setCreateSaving(false);
                  }
                }}
              />
            </Card>
            <div className="flex flex-col gap-2">
              {rows.map(({ coord, entry }) => {
                const id = coordId(coord);
                const isEditing = editingCoordId === id;
                return (
                  <Card key={id} padding="sm" className={entry.enabled === false ? "opacity-70" : ""}>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        {coord.scope === "global" ? (
                          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">
                            <span className="material-symbols-outlined text-[18px] text-text-muted">public</span>
                            Global
                          </p>
                        ) : (
                          <p className="min-w-0 flex-1 break-all font-mono text-[13px] text-primary">{coord.model}</p>
                        )}
                        <EntryBadge entry={entry} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs text-text-muted">
                          ~{estimateTokens(entryText(entry))} tokens
                        </span>
                        <span className="flex items-center gap-1 text-xs text-text-muted">
                          <span className="material-symbols-outlined text-[14px]">key</span>
                          {coord.keyId ? keyName(coord.keyId) : "All keys"}
                        </span>
                        {entry.templateName && (
                          <span className="text-xs text-text-muted">from template “{entry.templateName}”</span>
                        )}
                        <span className="flex-1" />
                        {coord.scope === "model" && (
                          <button
                            type="button"
                            onClick={() => copyName(coord.model)}
                            title="Copy name"
                            className={`${actionBtnClass} ${copied === `name:${coord.model}` ? "text-emerald-500 hover:text-emerald-500" : ""}`}
                          >
                            <span className="material-symbols-outlined text-[16px]">
                              {copied === `name:${coord.model}` ? "check" : "content_copy"}
                            </span>
                            {copied === `name:${coord.model}` ? "Copied" : "Copy"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingCoordId(isEditing ? null : id)}
                          title="Edit"
                          className={actionBtnClass}
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            {isEditing ? "expand_less" : "edit"}
                          </span>
                          Edit
                        </button>
                        <ConfirmButton
                          label="Delete"
                          icon="delete"
                          onConfirm={() => deleteCoord(coord)}
                        />
                      </div>
                    </div>
                    {isEditing && (
                      <div className="mt-3 border-t border-border-subtle pt-3">
                        <InjectionForm
                          key={`${id}-${entry.updatedAt || ""}`}
                          initialCoord={coord}
                          entryAt={entryAt}
                          keys={keys}
                          keyName={keyName}
                          modelOptions={modelOptions}
                          templates={templates}
                          allowTemplateSource={false}
                          saving={saving === id}
                          onSave={(newCoord, fields) => saveInjection(coord, newCoord, fields)}
                          onClear={() => deleteCoord(coord)}
                        />
                      </div>
                    )}
                  </Card>
                );
              })}
              {rows.length === 0 && (
                <p className="text-sm text-text-muted">No injections yet — create one above.</p>
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
                  <Button variant="outline" size="sm" onClick={() => setPvPickerOpen(true)} className="shrink-0 self-center whitespace-nowrap">
                    Browse
                  </Button>
                  <select
                    value={pvKeyId}
                    onChange={(e) => setPvKeyId(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <option value="">No key</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>{keyName(k.id)}</option>
                    ))}
                  </select>
                </div>
                <ModelSelectModal
                  isOpen={pvPickerOpen}
                  onClose={() => setPvPickerOpen(false)}
                  onSelect={(m) => {
                    setPvModel(m.value || m.id || "");
                    setPvPickerOpen(false);
                  }}
                  title="Select model"
                />
                {pvStack === null ? (
                  <p className="text-sm text-text-muted">…</p>
                ) : pvStack.length === 0 ? (
                  <p className="text-sm text-text-muted">This request receives no injection.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {pvStack.map((item, i) => (
                      <div key={i} className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-semibold text-primary">{item.name}</p>
                          <p className="line-clamp-2 text-xs text-text-muted">
                            {item.mode === "chat"
                              ? `${item.turns?.length || 0} scripted turns`
                              : item.text}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="science" title="Injection tester">
              Proof, not promises — fire a probe through the router and read the verdict.
            </SectionTitle>
            <Card>
              <InjectionTester />
            </Card>
          </section>

          <p className="text-center text-xs text-text-muted">
            Compression lives in <Link href="/dashboard/token-saver" className="underline">Token Saver</Link> —
            this page handles persona.
          </p>
        </>
      )}

      {editingTemplate !== undefined && (
        <TemplateModal
          template={editingTemplate}
          onClose={() => setEditingTemplate(undefined)}
          onSave={saveTemplate}
          saving={saving === "template"}
        />
      )}
    </div>
  );
}
