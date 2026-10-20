"use client";

// 9Router Pro — Soul Prompts: one system prompt per target, no library, no
// binding step. Three flat scopes: Global (the router's SOUL.md), User (per
// API key), Model (per model name). A request stacks global → user → model.

import { useCallback, useEffect, useState } from "react";

const PRESETS = [
  { name: "Format Rapi", content: "Always answer in clean, structured Markdown. Lead with the answer, then supporting detail. Use short headings and lists only where they help." },
  { name: "Bahasa Indonesia", content: "Selalu jawab dalam Bahasa Indonesia yang natural dan santai, kecuali user menulis dalam bahasa lain. Istilah teknis boleh tetap bahasa Inggris." },
  { name: "Coding Partner", content: "You are a senior pair-programmer. Prefer working code over explanations, point out edge cases and risks briefly, and never add filler." },
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function PositionPicker({ value, onChange }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-border text-xs font-medium">
      {["append", "prepend"].map((pos) => (
        <button
          key={pos}
          type="button"
          onClick={() => onChange(pos)}
          className={`px-2.5 py-1 capitalize transition-colors ${value === pos ? "bg-brand-500 text-white" : "text-text-muted hover:bg-surface-2"}`}
          title={pos === "prepend" ? "Before the client's own system prompt" : "After the client's own system prompt"}
        >
          {pos}
        </button>
      ))}
    </div>
  );
}

function SoulEditor({ initial, onSave, onDelete, saving, saveLabel = "Save" }) {
  const [content, setContent] = useState(initial?.content || "");
  const [position, setPosition] = useState(initial?.position || "append");
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const tokens = Math.max(0, Math.round(content.length / 4));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => setContent(p.content)}
            className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
          >
            {p.name}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-text-muted/70">~{tokens} tokens</span>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="Write the system prompt for this target…"
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-text-main outline-none focus:border-brand-500"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PositionPicker value={position} onChange={setPosition} />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-muted">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-brand-500" />
          Enabled
        </label>
        <div className="ml-auto flex gap-2">
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-500/10"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave({ content, position, enabled })}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function EntryCard({ title, entry, defaultOpen = false, onSave, onDelete, onToggleEnabled, saving }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[14px] border border-border-subtle bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-text-main" title={title}>{title}</span>
        <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] font-medium capitalize text-brand-500">{entry?.position || "append"}</span>
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-text-muted">
          <input
            type="checkbox"
            checked={entry?.enabled !== false}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            className="accent-brand-500"
          />
          On
        </label>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:text-text-main"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>
      {!open && entry?.content && (
        <p className="mt-2 line-clamp-2 text-[13px] text-text-muted">{entry.content}</p>
      )}
      {open && <div className="mt-3 border-t border-border-subtle pt-3"><SoulEditor initial={entry} onSave={onSave} onDelete={onDelete} saving={saving} /></div>}
    </div>
  );
}

export default function SoulPromptsClient() {
  const [global, setGlobal] = useState(null);
  const [userPrompts, setUserPrompts] = useState({});
  const [modelPrompts, setModelPrompts] = useState({});
  const [keys, setKeys] = useState([]);
  const [modelNames, setModelNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newKeyId, setNewKeyId] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [addingUser, setAddingUser] = useState(false);

  const refresh = useCallback(async () => {
    const { data } = await api("/api/soul-prompts");
    if (data) {
      setGlobal(data.global || null);
      setUserPrompts(data.userPrompts || {});
      setModelPrompts(data.prompts || {});
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    (async () => {
      const [keysRes, combosRes, modelsRes] = await Promise.all([
        api("/api/keys").catch(() => null),
        api("/api/combos").catch(() => null),
        api("/api/models").catch(() => null),
      ]);
      if (keysRes?.data?.keys) setKeys(keysRes.data.keys);
      const names = new Set();
      for (const c of combosRes?.data?.combos || []) if (c?.name) names.add(c.name);
      const rawModels = modelsRes?.data?.data || modelsRes?.data?.models || [];
      for (const m of rawModels) {
        const id = typeof m === "string" ? m : m?.id;
        if (id) names.add(id);
      }
      setModelNames([...names].sort());
    })();
  }, []);

  const wrap = async (tag, fn) => {
    setSaving(tag);
    try { await fn(); await refresh(); } finally { setSaving(""); }
  };

  const saveGlobal = (entry) => wrap("global", () => api("/api/soul-prompts", { method: "PUT", body: { global: entry } }));
  const saveModel = (model) => (entry) => wrap("model:" + model, () => api("/api/soul-prompts", { method: "PUT", body: { model, ...entry } }));
  const saveUser = (keyId) => (entry) => wrap("user:" + keyId, () => api("/api/soul-prompts", { method: "PUT", body: { keyId, ...entry } }));
  const delModel = (model) => () => wrap("model:" + model, () => api(`/api/soul-prompts?model=${encodeURIComponent(model)}`, { method: "DELETE" }));
  const delUser = (keyId) => () => wrap("user:" + keyId, () => api(`/api/soul-prompts?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE" }));
  const toggleModel = (model, entry) => (enabled) => saveModel(model)({ ...entry, enabled });
  const toggleUser = (keyId, entry) => (enabled) => saveUser(keyId)({ ...entry, enabled });
  const toggleGlobal = (enabled) => global && saveGlobal({ ...global, enabled });

  const keyName = (id) => keys.find((k) => k.id === id)?.name || id.slice(0, 8) + "…";
  const keysWithoutSoul = keys.filter((k) => !(k.id in userPrompts));

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-text-main">
          <span className="material-symbols-outlined text-brand-500">psychology</span>
          Soul Prompts
        </h1>
        <p className="mt-0.5 text-sm text-text-muted">
          One system prompt per target — no library, no binding step. A request stacks them in order: global → user → model.
        </p>
        <p className="mt-0.5 text-xs text-text-muted/70">
          9Router Pro · by Gienetic ·{" "}
          <a href="https://github.com/giienew" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">GitHub</a>{" "}
          ·{" "}
          <a href="https://t.me/gienetic" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">Telegram</a>
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          {/* ------------------------------------------------ global */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-text-muted">
              <span className="material-symbols-outlined text-[16px]">public</span> Global Soul
            </h2>
            <p className="mb-2 text-xs text-text-muted/80">The router's SOUL.md — injected into every chat request, whatever the model or key.</p>
            {global ? (
              <EntryCard
                title="All models · all users"
                entry={global}
                onSave={saveGlobal}
                onDelete={() => saveGlobal({ content: "" })}
                onToggleEnabled={toggleGlobal}
                saving={saving === "global"}
              />
            ) : (
              <div className="rounded-[14px] border border-border-subtle bg-surface p-4">
                <SoulEditor initial={null} onSave={saveGlobal} saving={saving === "global"} saveLabel="Set global soul" />
              </div>
            )}
          </section>

          {/* ------------------------------------------------ user */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-text-muted">
              <span className="material-symbols-outlined text-[16px]">key</span> User Souls — per API key
            </h2>
            <p className="mb-2 text-xs text-text-muted/80">Whoever calls with that key gets this persona, on any model.</p>
            <div className="space-y-3">
              {Object.entries(userPrompts).map(([keyId, entry]) => (
                <EntryCard
                  key={keyId}
                  title={keyName(keyId)}
                  entry={entry}
                  onSave={saveUser(keyId)}
                  onDelete={delUser(keyId)}
                  onToggleEnabled={toggleUser(keyId, entry)}
                  saving={saving === "user:" + keyId}
                />
              ))}
              {addingUser ? (
                <div className="rounded-[14px] border border-dashed border-border bg-surface p-4">
                  <select
                    value={newKeyId}
                    onChange={(e) => setNewKeyId(e.target.value)}
                    className="mb-3 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-text-main outline-none focus:border-brand-500"
                  >
                    <option value="">Pick an API key…</option>
                    {keysWithoutSoul.map((k) => (
                      <option key={k.id} value={k.id}>{k.name}</option>
                    ))}
                  </select>
                  {newKeyId && <SoulEditor initial={null} onSave={(entry) => { saveUser(newKeyId)(entry); setAddingUser(false); setNewKeyId(""); }} saving={saving.startsWith("user:")} saveLabel="Set user soul" />}
                  <button type="button" onClick={() => setAddingUser(false)} className="mt-2 text-xs text-text-muted underline">Cancel</button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingUser(true)}
                  disabled={keysWithoutSoul.length === 0}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500 disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span> Add user soul
                </button>
              )}
            </div>
          </section>

          {/* ------------------------------------------------ model */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-text-muted">
              <span className="material-symbols-outlined text-[16px]">smart_toy</span> Model Souls — per model
            </h2>
            <p className="mb-2 text-xs text-text-muted/80">Matched by the name clients call: a combo, an alias, or provider/model.</p>
            <div className="space-y-3">
              {Object.entries(modelPrompts).map(([model, entry]) => (
                <EntryCard
                  key={model}
                  title={model}
                  entry={entry}
                  onSave={saveModel(model)}
                  onDelete={delModel(model)}
                  onToggleEnabled={toggleModel(model, entry)}
                  saving={saving === "model:" + model}
                />
              ))}
              {addingModel ? (
                <div className="rounded-[14px] border border-dashed border-border bg-surface p-4">
                  <input
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    list="soul-model-names"
                    placeholder="Model name — e.g. dpsk_un or dahl/zai-org/GLM-5.3-Flash"
                    className="mb-3 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-sm text-text-main outline-none focus:border-brand-500"
                  />
                  <datalist id="soul-model-names">
                    {modelNames.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                  {newModel.trim() && <SoulEditor initial={null} onSave={(entry) => { saveModel(newModel.trim())(entry); setAddingModel(false); setNewModel(""); }} saving={saving.startsWith("model:")} saveLabel="Set model soul" />}
                  <button type="button" onClick={() => setAddingModel(false)} className="mt-2 text-xs text-text-muted underline">Cancel</button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingModel(true)}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span> Add model soul
                </button>
              )}
            </div>
          </section>

          <div className="rounded-[14px] border border-border-subtle bg-surface p-4 text-sm text-text-muted">
            <p className="flex items-center gap-1.5 font-medium text-text-main">
              <span className="material-symbols-outlined text-[16px] text-brand-500">info</span>
              Prepend or append?
            </p>
            <p className="mt-1.5">
              <b className="text-text-main">Prepend</b> puts the soul before the client's own system prompt — strongest for
              taking over instructions. <b className="text-text-main">Append</b> puts it last — models tend to obey the
              most recent instruction. When several souls stack, prepends land in global → user → model order at the
              front, appends in the same order at the back.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
