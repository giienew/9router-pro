"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { InjectionTester } from "./InjectExtras";

const API = "/api/prompt-injection";

const PRESETS = [
  {
    label: "Format Rapi",
    content:
      "Selalu jawab dengan format yang rapi dan terstruktur: gunakan heading singkat, poin-poin, dan contoh bila membantu. Hindari paragraf panjang yang bertele-tele.",
  },
  {
    label: "Bahasa Indonesia",
    content:
      "Selalu jawab dalam Bahasa Indonesia yang natural dan santai, kecuali user meminta bahasa lain atau menempelkan teks dalam bahasa lain.",
  },
  {
    label: "Coding Partner",
    content:
      "Kamu adalah coding partner yang to the point: berikan kode yang lengkap dan bisa langsung jalan, jelaskan hanya bagian yang tidak obvious, dan sebutkan asumsi yang kamu buat.",
  },
];

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
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setContent(p.content)}
                className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-text-muted transition-colors hover:border-primary hover:text-primary"
              >
                {p.label}
              </button>
            ))}
          </div>
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

export default function PromptInjectionClient() {
  const [msg, setMsg] = useState(null);
  const showToast = useCallback((text, type = "success") => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 2600);
  }, []);
  const [loading, setLoading] = useState(true);
  const [global_, setGlobal] = useState(null);
  const [userPrompts, setUserPrompts] = useState({});
  const [prompts, setPrompts] = useState({});
  const [keys, setKeys] = useState([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [newModel, setNewModel] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [saving, setSaving] = useState("");

  const load = useCallback(async () => {
    try {
      const [injRes, keyRes] = await Promise.all([fetch(API), fetch("/api/keys")]);
      const inj = await injRes.json();
      setGlobal(inj.global || null);
      setUserPrompts(inj.userPrompts || {});
      setPrompts(inj.prompts || {});
      const keyData = await keyRes.json();
      const list = Array.isArray(keyData?.keys) ? keyData.keys : Array.isArray(keyData) ? keyData : [];
      setKeys(list);
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
    } catch {
      showToast("Failed to save", "error");
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

  // ---- Stack Preview (Pro) ----
  const [pvModel, setPvModel] = useState("");
  const [pvKeyId, setPvKeyId] = useState("");
  const [pvStack, setPvStack] = useState(null);
  const runPreview = async () => {
    try {
      const qs = new URLSearchParams({ preview: "1", model: pvModel, keyId: pvKeyId });
      const res = await fetch(`${API}?${qs}`);
      const data = await res.json();
      setPvStack(data.stack || []);
    } catch {
      showToast("Preview failed", "error");
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <span className="material-symbols-outlined text-primary">skull</span>
          Prompt Injection
        </h1>
        {msg && (
          <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${msg.type === "error" ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"}`}>
            {msg.text}
          </p>
        )}
        <p className="mt-1 text-sm leading-relaxed text-text-muted">
          One injection per target — no library, no binding step. A request stacks them in
          order: global → user → model. Each one is either a single system prompt or a
          scripted chat inserted as a conversation that already happened.
        </p>
        <p className="mt-1 text-xs text-text-muted">
          9Router Pro · by Gienetic ·{" "}
          <a className="underline" href="https://github.com/giienew" target="_blank" rel="noreferrer">GitHub</a>
          {" "}·{" "}
          <a className="underline" href="https://t.me/gienetic" target="_blank" rel="noreferrer">Telegram</a>
        </p>
        <div className="mt-3 flex gap-2">
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
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle icon="public" title="Global injection">
              Applies to every chat request, whatever the model or key.
            </SectionTitle>
            <Card>
              <InjectEditor
                key={`global-${global_?.updatedAt || "new"}`}
                initial={global_}
                saving={saving === "global"}
                onSave={(entry) => put({ global: entry }, "global", "Global injection saved")}
                onClear={global_ ? () => put({ global: {} }, "global", "Global injection cleared") : undefined}
                clearLabel="Clear"
              />
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
            <div className="flex gap-2">
              <input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="model or combo name — e.g. my-assistant"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]"
              />
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
            <div className="flex flex-col gap-3">
              {modelNames.map((name) => (
                <Card key={`${name}-${prompts[name]?.updatedAt || ""}`}>
                  <div className="mb-3 flex items-center gap-2">
                    <p className="break-all font-mono text-[13px] text-primary">{name}</p>
                    <span className="ml-auto shrink-0"><EntryBadge entry={prompts[name]} /></span>
                  </div>
                  <InjectEditor
                    initial={prompts[name]}
                    saving={saving === `model-${name}`}
                    onSave={(entry) => put({ model: name, ...entry }, `model-${name}`, "Model injection saved")}
                    onClear={() => del(`model=${encodeURIComponent(name)}`, `model-${name}`, "Model injection deleted")}
                    clearLabel="Delete"
                  />
                </Card>
              ))}
              {modelNames.length === 0 && (
                <p className="text-sm text-text-muted">No model injections yet — add one above.</p>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon="layers" title="Stack preview">
              Exactly what one request receives, in order — pick a model and a key.
            </SectionTitle>
            <Card>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={pvModel}
                    onChange={(e) => setPvModel(e.target.value)}
                    placeholder="model or combo name — e.g. my-assistant"
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
                  <Button size="sm" onClick={runPreview}>Preview</Button>
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

      <ModelSelectModal
        isOpen={showModelPicker}
        onClose={() => setShowModelPicker(false)}
        onSelect={(m) => setNewModel(m.value || m.id || "")}
      />
    </div>
  );
}
