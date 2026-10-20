"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { cn } from "@/shared/utils/cn";

// 9Router Pro — Prompt Inject
// Reusable system-prompt profiles, injected per request through the upstream
// format-aware injector. Bindings resolve in order: global → per-key → per-model.

const PRESETS = [
  {
    name: "Format Rapi",
    position: "append",
    content:
      "Always answer in well-structured Markdown: short headings, bullet lists for enumerations, and fenced code blocks for code. Never bury lists inside a single paragraph. If the user asks for JSON, output valid JSON only — no prose, no code fences.",
  },
  {
    name: "Bahasa Indonesia",
    position: "prepend",
    content:
      "Selalu jawab dalam Bahasa Indonesia yang natural dan profesional, kecuali user menulis dalam bahasa lain atau secara eksplisit meminta bahasa lain. Istilah teknis boleh tetap dalam Bahasa Inggris bila lebih jelas.",
  },
  {
    name: "Coding Partner",
    position: "append",
    content:
      "You are a senior pair-programmer. Be direct and concise: lead with the working code or the fix, then explain briefly only if needed. Prefer complete, runnable code over pseudocode. Point out bugs, edge cases, and security issues you notice, even if not asked.",
  },
];

function emptyForm() {
  return { id: null, name: "", content: "", position: "append", enabled: true };
}

function maskKey(key) {
  if (!key || typeof key !== "string") return "";
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

function ProfileChips({ profiles, selected, onToggle }) {
  if (!profiles.length) {
    return <p className="text-xs text-text-muted">No profiles yet — create one first.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {profiles.map((p) => {
        const active = selected.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onToggle(p.id)}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs border transition-all cursor-pointer",
              active
                ? "bg-brand-500/10 border-brand-500/50 text-brand-600 dark:text-brand-300 font-medium"
                : "bg-surface-2 border-border-subtle text-text-muted hover:border-brand-500/30 hover:text-text-main",
              !p.enabled && "opacity-50"
            )}
          >
            {p.name}
            {!p.enabled ? " (off)" : ""}
          </button>
        );
      })}
    </div>
  );
}

export default function PromptInjectClient() {
  const notify = useNotificationStore();
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]);
  const [bindings, setBindings] = useState({ global: [], byKey: {}, byModel: {} });
  const [keys, setKeys] = useState([]);
  const [modelNames, setModelNames] = useState([]);
  const [showEditor, setShowEditor] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [modelDraft, setModelDraft] = useState("");
  const [extraModels, setExtraModels] = useState([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/prompt-inject");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "load failed");
      setProfiles(data.profiles || []);
      setBindings(data.bindings || { global: [], byKey: {}, byModel: {} });
    } catch {
      notify.error("Failed to load Prompt Inject");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/keys");
        const data = await res.json();
        if (res.ok) setKeys(data.keys || []);
      } catch { /* keys section just stays empty */ }
    })();
    (async () => {
      const names = new Set();
      try {
        const res = await fetch("/api/combos");
        const data = await res.json();
        for (const c of data.combos || []) if (c?.name) names.add(c.name);
      } catch { /* suggestions are optional */ }
      try {
        const res = await fetch("/api/models");
        const data = await res.json();
        const raw = data.models || data.data || [];
        for (const m of raw) {
          const n = typeof m === "string" ? m : m?.id || m?.name;
          if (n) names.add(n);
        }
      } catch { /* suggestions are optional */ }
      setModelNames([...names].sort());
    })();
  }, []);

  const saveBindings = async (next) => {
    setBindings(next);
    try {
      const res = await fetch("/api/prompt-inject", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bindings: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save failed");
      if (data.bindings) setBindings(data.bindings);
    } catch {
      notify.error("Failed to save bindings");
      load();
    }
  };

  const toggleInList = (list, id) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const toggleGlobal = (id) =>
    saveBindings({ ...bindings, global: toggleInList(bindings.global, id) });

  const toggleForKey = (keyId, id) =>
    saveBindings({
      ...bindings,
      byKey: { ...bindings.byKey, [keyId]: toggleInList(bindings.byKey[keyId] || [], id) },
    });

  const toggleForModel = (model, id) =>
    saveBindings({
      ...bindings,
      byModel: { ...bindings.byModel, [model]: toggleInList(bindings.byModel[model] || [], id) },
    });

  const removeModelBinding = (model) => {
    const byModel = { ...bindings.byModel };
    delete byModel[model];
    setExtraModels((prev) => prev.filter((m) => m !== model));
    saveBindings({ ...bindings, byModel });
  };

  const addModelRow = () => {
    const name = modelDraft.trim();
    if (!name) return;
    if (!extraModels.includes(name) && !bindings.byModel[name]) {
      setExtraModels((prev) => [...prev, name]);
    }
    setModelDraft("");
  };

  const openCreate = () => {
    setForm(emptyForm());
    setShowEditor(true);
  };

  const openEdit = (profile) => {
    setForm({
      id: profile.id,
      name: profile.name,
      content: profile.content,
      position: profile.position,
      enabled: profile.enabled,
    });
    setShowEditor(true);
  };

  const applyPreset = (preset) => {
    setForm({ id: null, name: preset.name, content: preset.content, position: preset.position, enabled: true });
    setShowEditor(true);
  };

  const saveProfile = async () => {
    if (!form.name.trim()) return notify.error("Name is required");
    if (!form.content.trim()) return notify.error("Content is required");
    setSaving(true);
    try {
      const url = form.id ? `/api/prompt-inject/profiles/${form.id}` : "/api/prompt-inject/profiles";
      const res = await fetch(url, {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          content: form.content,
          position: form.position,
          enabled: form.enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save failed");
      notify.success(form.id ? "Profile updated" : "Profile created");
      setShowEditor(false);
      load();
    } catch (e) {
      notify.error(e.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const toggleProfileEnabled = async (profile) => {
    try {
      const res = await fetch(`/api/prompt-inject/profiles/${profile.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !profile.enabled }),
      });
      if (!res.ok) throw new Error();
      setProfiles((prev) => prev.map((p) => (p.id === profile.id ? { ...p, enabled: !p.enabled } : p)));
    } catch {
      notify.error("Failed to update profile");
    }
  };

  const deleteProfile = async () => {
    if (!confirmDelete) return;
    try {
      const res = await fetch(`/api/prompt-inject/profiles/${confirmDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      notify.success("Profile deleted");
      setConfirmDelete(null);
      load();
    } catch {
      notify.error("Failed to delete profile");
    }
  };

  const modelRows = [...new Set([...Object.keys(bindings.byModel), ...extraModels])].sort();

  // ---- Import / export (Pro): share or back up profiles + bindings as JSON
  const importRef = useRef(null);
  const [importing, setImporting] = useState(false);

  const exportProfiles = () => {
    const payload = {
      app: "9router-pro",
      kind: "prompt-inject",
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles,
      bindings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prompt-inject-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importProfiles = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.kind !== "prompt-inject" || !Array.isArray(payload.profiles)) {
        throw new Error("Not a Prompt Inject export file");
      }
      const idMap = new Map();
      for (const p of payload.profiles) {
        const res = await fetch("/api/prompt-inject/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: p.name, content: p.content, position: p.position, enabled: p.enabled !== false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import failed");
        if (p.id && data.profile?.id) idMap.set(p.id, data.profile.id);
      }
      const mapIds = (ids) => (ids || []).map((id) => idMap.get(id)).filter(Boolean);
      const mergeList = (a, b) => [...new Set([...(a || []), ...(b || [])])];
      const src = payload.bindings || { global: [], byKey: {}, byModel: {} };
      const next = {
        global: mergeList(bindings.global, mapIds(src.global)),
        byKey: { ...bindings.byKey },
        byModel: { ...bindings.byModel },
      };
      for (const scope of ["byKey", "byModel"]) {
        for (const [k, ids] of Object.entries(src[scope] || {})) {
          const mapped = mapIds(ids);
          if (mapped.length) next[scope][k] = mergeList(next[scope][k], mapped);
        }
      }
      await saveBindings(next);
      notify.success(`Imported ${idMap.size} profile(s)`);
      load();
    } catch (e) {
      notify.error(e.message || "Import failed");
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-[12px] bg-surface border border-border-subtle">
            <span className="material-symbols-outlined text-[24px] text-primary">prompt_suggestion</span>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-main">Prompt Inject</h1>
            <p className="text-sm text-text-muted">
              System prompt profiles injected into every matching request — global, per API key, or per model.
            </p>
            <p className="text-xs text-text-muted/70 mt-0.5">
              9Router Pro · by Gienetic ·{" "}
              <a href="https://github.com/giienew" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">
                GitHub
              </a>{" "}
              ·{" "}
              <a href="https://t.me/gienetic" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">
                Telegram
              </a>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => importProfiles(e.target.files?.[0])}
          />
          <Button variant="secondary" icon="upload" loading={importing} onClick={() => importRef.current?.click()}>
            Import
          </Button>
          <Button variant="secondary" icon="download" onClick={exportProfiles}>
            Export
          </Button>
          <Button variant="primary" icon="add" onClick={openCreate}>
            New Profile
          </Button>
        </div>
      </div>

      {/* Profiles */}
      <Card title="Profiles" subtitle="Reusable system prompts. Injection order: global → key → model." icon="prompt_suggestion">
        {profiles.length === 0 ? (
          <div className="text-center py-10">
            <span className="material-symbols-outlined text-[40px] text-text-muted/50">text_snippet</span>
            <p className="text-sm text-text-muted mt-2">No profiles yet. Create one, or start from a preset below.</p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {profiles.map((p) => (
              <div key={p.id} className="py-3.5 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-text-main">{p.name}</span>
                    <Badge variant={p.position === "prepend" ? "info" : "default"}>
                      {p.position === "prepend" ? "Prepend" : "Append"}
                    </Badge>
                    {!p.enabled && <Badge variant="warning">Off</Badge>}
                    <span className="text-xs text-text-muted">
                      {p.content.length} chars · ~{Math.max(1, Math.ceil(p.content.length / 4))} tokens
                    </span>
                  </div>
                  <p className="text-xs text-text-muted font-mono truncate mt-1">{p.content.split("\n")[0]}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Toggle checked={p.enabled} onChange={() => toggleProfileEnabled(p)} size="sm" />
                  <Button variant="ghost" size="sm" icon="edit" onClick={() => openEdit(p)} />
                  <Button variant="ghost" size="sm" icon="delete" onClick={() => setConfirmDelete(p)} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Presets */}
        <div className="mt-5 pt-4 border-t border-border-subtle">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Start from a preset</p>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => applyPreset(preset)}
                className="px-2.5 py-1 rounded-full text-xs border border-border-subtle bg-surface-2 text-text-muted hover:border-brand-500/30 hover:text-text-main transition-all cursor-pointer"
              >
                + {preset.name}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Bindings */}
      <Card title="Bindings" subtitle="Pick which profiles apply where. Changes save automatically." icon="link">
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">public</span>
              <h3 className="font-medium text-text-main">Global</h3>
              <span className="text-xs text-text-muted">— injected into every chat request</span>
            </div>
            <ProfileChips profiles={profiles} selected={bindings.global} onToggle={toggleGlobal} />
          </div>

          <div className="pt-5 border-t border-border-subtle">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-[18px] text-text-muted">key</span>
              <h3 className="font-medium text-text-main">Per API Key</h3>
              <span className="text-xs text-text-muted">— a persona for whoever holds the key</span>
            </div>
            {keys.length === 0 ? (
              <p className="text-xs text-text-muted">No API keys yet — create one under Endpoint &amp; Key.</p>
            ) : (
              <div className="space-y-4">
                {keys.map((k) => (
                  <div key={k.id} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-main">{k.name || "Unnamed key"}</span>
                      <span className="text-xs text-text-muted font-mono">{maskKey(k.key)}</span>
                      {k.isActive === false && <Badge variant="warning">Inactive</Badge>}
                    </div>
                    <ProfileChips profiles={profiles} selected={bindings.byKey[k.id] || []} onToggle={(id) => toggleForKey(k.id, id)} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-5 border-t border-border-subtle">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-[18px] text-text-muted">smart_toy</span>
              <h3 className="font-medium text-text-main">Per Model</h3>
              <span className="text-xs text-text-muted">— matched by the name clients call: combo, alias, or provider/model</span>
            </div>
            <div className="space-y-4">
              {modelRows.map((model) => (
                <div key={model} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-main font-mono">{model}</span>
                    <button
                      type="button"
                      onClick={() => removeModelBinding(model)}
                      className="text-text-muted hover:text-red-500 transition-colors cursor-pointer"
                      title="Remove this model binding"
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  </div>
                  <ProfileChips profiles={profiles} selected={bindings.byModel[model] || []} onToggle={(id) => toggleForModel(model, id)} />
                </div>
              ))}
              <div className="flex items-center gap-2 max-w-md">
                <div className="flex-1">
                  <Input
                    placeholder="Model name — e.g. dpsk_un or dahl/deepseek-ai/DeepSeek-V4"
                    value={modelDraft}
                    onChange={(e) => setModelDraft(e.target.value)}
                    list="prompt-inject-models"
                  />
                  <datalist id="prompt-inject-models">
                    {modelNames.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </div>
                <Button variant="secondary" icon="add" onClick={addModelRow}>
                  Add
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* How it works */}
      <Card title="How injection works" icon="info">
        <div className="text-sm text-text-muted space-y-2">
          <p>
            Profiles are merged into the system prompt <em>after</em> format translation, using the router&apos;s own
            wire-aware injector — OpenAI, Claude, Gemini, Responses, and Kiro bodies all receive the text in their
            native system slot. Injection is idempotent (never duplicated on retries) and fails open: a broken
            profile can never break a chat request.
          </p>
          <p>
            <strong className="text-text-main font-medium">Prepend</strong> puts the profile before the client&apos;s own
            system prompt (strongest framing). <strong className="text-text-main font-medium">Append</strong> adds it after.
            Within one request the order is: global profiles, then the API key&apos;s, then the model&apos;s.
          </p>
        </div>
      </Card>

      {/* Editor modal */}
      <Modal
        isOpen={showEditor}
        onClose={() => setShowEditor(false)}
        title={form.id ? "Edit Profile" : "New Profile"}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowEditor(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveProfile} loading={saving} icon="save">
              Save Profile
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="e.g. Hermes Persona"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">Position</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "prepend", icon: "vertical_align_top", title: "Prepend", desc: "Before the client's system prompt" },
                { value: "append", icon: "vertical_align_bottom", title: "Append", desc: "After the client's system prompt" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm({ ...form, position: opt.value })}
                  className={cn(
                    "text-left p-3 rounded-[10px] border transition-all cursor-pointer",
                    form.position === opt.value
                      ? "bg-brand-500/10 border-brand-500/50"
                      : "bg-surface-2 border-border-subtle hover:border-brand-500/30"
                  )}
                >
                  <span className="flex items-center gap-1.5 font-medium text-sm text-text-main">
                    <span className="material-symbols-outlined text-[18px]">{opt.icon}</span>
                    {opt.title}
                  </span>
                  <span className="block text-xs text-text-muted mt-1">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">
              System prompt
              <span className="float-right text-xs font-normal text-text-muted">
                {form.content.length} chars · ~{Math.max(0, Math.ceil(form.content.length / 4))} tokens
              </span>
            </label>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Write the instruction exactly as the model should receive it…"
              rows={9}
              className="w-full py-2.5 px-3 text-sm font-mono text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 resize-y"
            />
          </div>
          <Toggle
            checked={form.enabled}
            onChange={(v) => setForm({ ...form, enabled: v })}
            label="Enabled"
            description="Disabled profiles are stored but never injected"
          />
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={deleteProfile}
        title="Delete profile"
        message={`Delete "${confirmDelete?.name}"? It will be removed from all bindings.`}
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}
