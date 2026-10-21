"use client";

// Token Saver Pro (9Router Pro): savings stats from real RTK traffic,
// a test bench running the real RTK pipeline, and Brief Mode —
// per-scope Caveman levels (global / per API key / per model).

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

const LEVELS = [
  { id: "", label: "Off" },
  { id: "lite", label: "Lite — light trim" },
  { id: "full", label: "Full — terse" },
  { id: "ultra", label: "Ultra — maximum terse" },
];

const estTokens = (bytes) => Math.round((bytes || 0) / 4);
const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`);

const SAMPLES = {
  "Git diff": () => {
    const lines = ["diff --git a/src/app.js b/src/app.js", "index 1111111..2222222 100644", "--- a/src/app.js", "+++ b/src/app.js", "@@ -10,24 +10,24 @@ function main() {"];
    for (let i = 0; i < 22; i++) lines.push(` const setting${i} = loadConfig('section${i}', { cache: true, retries: 3 });`);
    lines.push("-  return render(oldTemplate);");
    lines.push("+  return render(newTemplate);");
    for (let i = 22; i < 44; i++) lines.push(` const setting${i} = loadConfig('section${i}', { cache: true, retries: 3 });`);
    return lines.join("\n");
  },
  "Build log": () => {
    const lines = [];
    for (let i = 0; i < 260; i++) {
      lines.push(i % 7 === 0 ? `webpack compiled chunk ${i} successfully` : "WARNING in ./src/module.js: 'unusedVar' is defined but never used");
    }
    lines.push("Build finished in 42.1s");
    return lines.join("\n");
  },
  "Server log": () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`2026-01-01T10:00:${String(i % 60).padStart(2, "0")}Z GET /api/health 200 2ms`);
    lines.push("ERROR 2026-01-01T10:01:00Z database connection timeout after 30000ms");
    for (let i = 0; i < 60; i++) lines.push(`2026-01-01T10:02:${String(i % 60).padStart(2, "0")}Z GET /api/health 200 2ms`);
    return lines.join("\n");
  },
};

function SavingsPanel() {
  const [stats, setStats] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/token-saver/stats?days=14");
      if (r.ok) setStats(await r.json());
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const t = stats?.totals;
  const savedBytes = t ? (t.bytesBefore || 0) - (t.bytesAfter || 0) : 0;
  const pct = t && t.bytesBefore > 0 ? ((savedBytes / t.bytesBefore) * 100).toFixed(1) : "0";
  const maxDay = stats ? Math.max(1, ...stats.days.map((d) => (d.bytesBefore || 0) - (d.bytesAfter || 0))) : 1;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="material-symbols-outlined text-primary">savings</span>
          Savings — last 14 days
        </h2>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>
      {!stats ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : t.requests === 0 ? (
        <p className="text-sm leading-relaxed text-text-muted">
          Nothing compressed yet. Stats appear here once RTK compresses tool output in a chat
          request — try the Test Bench below to see what it does. Counting started with this
          version; past traffic was only written to the console log.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Est. tokens saved", fmtNum(estTokens(savedBytes))],
              ["Requests compressed", `${t.requests}`],
              ["Tool outputs shrunk", `${t.hits}`],
              ["Avg. saving", `${pct}%`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-surface px-3 py-2.5">
                <div className="text-xl font-semibold">{value}</div>
                <div className="text-xs text-text-muted">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex h-20 items-end gap-1" title="Estimated tokens saved per day">
            {stats.days.map((d) => {
              const saved = (d.bytesBefore || 0) - (d.bytesAfter || 0);
              return (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-sm bg-primary/70"
                    style={{ height: `${Math.max(3, (saved / maxDay) * 100)}%` }}
                    title={`${d.date}: ~${fmtNum(estTokens(saved))} tokens saved`}
                  />
                  <span className="text-[9px] text-text-muted">{d.date.slice(8)}</span>
                </div>
              );
            })}
          </div>
          {stats.topFilters?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {stats.topFilters.map((f) => (
                <span key={f.name} className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
                  {f.name} · {f.hits} hits · ~{fmtNum(estTokens(f.saved))} tok
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-text-muted">Estimates from RTK byte savings (÷4 chars/token), counted on this instance only.</p>
        </>
      )}
    </Card>
  );
}

function TestBench() {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/token-saver/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setResult(await r.json());
    } catch {
      setResult({ error: "Request failed" });
    }
    setBusy(false);
  };

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <span className="material-symbols-outlined text-primary">science</span>
        Test Bench
      </h2>
      <p className="mb-3 text-sm text-text-muted">
        Paste a tool output and run the exact RTK pipeline a chat request would hit. Nothing is sent upstream.
      </p>
      <div className="mb-2 flex flex-wrap gap-2">
        {Object.entries(SAMPLES).map(([name, gen]) => (
          <button
            key={name}
            type="button"
            onClick={() => { setText(gen()); setResult(null); }}
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-text-muted transition-colors hover:border-primary hover:text-primary"
          >
            Sample: {name}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder="Paste a git diff, build log, test output… (RTK engages from ~500 characters)"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={busy || text.length === 0}>
          {busy ? "Compressing…" : "Compress"}
        </Button>
        <span className="text-xs text-text-muted">{text.length.toLocaleString()} chars · ~{fmtNum(Math.ceil(text.length / 4))} tokens</span>
      </div>
      {result && !result.error && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="rounded-lg bg-primary/10 px-3 py-1.5 font-medium text-primary">
              {result.applied ? `Saved ${result.savedPct}% · ~${fmtNum(result.saved.tokens)} tokens` : "No compression applied"}
            </span>
            {result.filters.map((f) => (
              <span key={f} className="rounded-lg border border-border px-3 py-1.5 text-text-muted">{f}</span>
            ))}
            <span className="rounded-lg border border-border px-3 py-1.5 text-text-muted">
              {result.before.chars.toLocaleString()} → {result.after.chars.toLocaleString()} chars
            </span>
          </div>
          {!result.applied && (
            <p className="text-xs text-text-muted">RTK skips small inputs (&lt;500 chars) and content no filter recognizes — long repetitive logs, diffs and build output compress best.</p>
          )}
          {result.applied && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.03] p-3 font-mono text-[11px] dark:bg-white/[0.03]">{result.output}</pre>
          )}
        </div>
      )}
      {result?.error && <p className="mt-3 text-sm text-red-500">{result.error}</p>}
    </Card>
  );
}

function LevelSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
    >
      {LEVELS.map((l) => (
        <option key={l.id} value={l.id}>{l.label}</option>
      ))}
    </select>
  );
}

function BriefMode() {
  const [data, setData] = useState({ global: null, byKey: {}, byModel: {} });
  const [keys, setKeys] = useState([]);
  const [models, setModels] = useState([]);
  const [selKey, setSelKey] = useState("");
  const [selKeyLevel, setSelKeyLevel] = useState("full");
  const [modelName, setModelName] = useState("");
  const [selModelLevel, setSelModelLevel] = useState("full");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/token-saver/brief");
      if (r.ok) setData(await r.json());
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch("/api/keys").then((r) => r.json()).then((d) => setKeys(d.keys || [])).catch(() => {});
    fetch("/api/models").then((r) => r.json()).then((d) => setModels((d.data || []).map((m) => m.id).filter(Boolean))).catch(() => {});
  }, []);

  const put = async (body) => {
    setMsg("");
    const r = await fetch("/api/token-saver/brief", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { setData(await r.json()); setMsg("Saved."); }
    else setMsg((await r.json().catch(() => ({}))).error || "Failed to save");
  };
  const del = async (qs) => {
    const r = await fetch(`/api/token-saver/brief?${qs}`, { method: "DELETE" });
    if (r.ok) setData(await r.json());
  };
  const keyName = (id) => keys.find((k) => k.id === id)?.name || id.slice(0, 8) + "…";

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <span className="material-symbols-outlined text-primary">compress</span>
        Brief Mode
      </h2>
      <p className="mb-4 text-sm leading-relaxed text-text-muted">
        Terse answers, scoped like Prompt Injection: a model entry beats a key entry, which beats
        the global level. Where nothing is set, the global Caveman settings above apply as before.
      </p>
      {msg && <p className="mb-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">{msg}</p>}

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 text-sm font-medium">Global</span>
          <LevelSelect value={data.global || ""} onChange={(v) => put({ global: v || null })} />
          <span className="text-xs text-text-muted">Applies to every request without a more specific entry.</span>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className="w-28 text-sm font-medium">Per API key</span>
            <select
              value={selKey}
              onChange={(e) => setSelKey(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
            >
              <option value="">— select a key —</option>
              {keys.map((k) => <option key={k.id} value={k.id}>{k.name || k.id.slice(0, 8)}</option>)}
            </select>
            <LevelSelect value={selKeyLevel} onChange={setSelKeyLevel} />
            <Button size="sm" disabled={!selKey} onClick={() => put({ keyId: selKey, level: selKeyLevel })}>Save</Button>
          </div>
          <div className="space-y-1.5 pl-0 sm:pl-28">
            {Object.entries(data.byKey || {}).map(([id, level]) => (
              <div key={id} className="flex items-center gap-2 text-sm">
                <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs">{keyName(id)}</span>
                <span className="text-text-muted">{level}</span>
                <button type="button" onClick={() => del(`keyId=${encodeURIComponent(id)}`)} className="text-xs text-red-500 hover:underline">remove</button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className="w-28 text-sm font-medium">Per model</span>
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              list="brief-model-list"
              placeholder="model or combo name"
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-sm"
            />
            <datalist id="brief-model-list">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <LevelSelect value={selModelLevel} onChange={setSelModelLevel} />
            <Button size="sm" disabled={!modelName.trim()} onClick={() => put({ model: modelName.trim(), level: selModelLevel })}>Save</Button>
          </div>
          <div className="space-y-1.5 pl-0 sm:pl-28">
            {Object.entries(data.byModel || {}).map(([name, level]) => (
              <div key={name} className="flex items-center gap-2 text-sm">
                <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs">{name}</span>
                <span className="text-text-muted">{level}</span>
                <button type="button" onClick={() => del(`model=${encodeURIComponent(name)}`)} className="text-xs text-red-500 hover:underline">remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function AntiFlakyCard() {
  const [enabled, setEnabled] = useState(true);
  const [maxRetries, setMaxRetries] = useState(2);
  const [loaded, setLoaded] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/settings");
        if (r.ok) {
          const s = await r.json();
          setEnabled(s.antiFlakyEnabled !== false);
          if (Number.isFinite(s.antiFlakyMaxRetries)) setMaxRetries(s.antiFlakyMaxRetries);
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const save = async (patch, apply) => {
    apply();
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (r.ok) {
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1500);
      }
    } catch {}
  };

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <span className="material-symbols-outlined text-brand-500">shield</span>
        <h3 className="font-semibold">Anti-Flaky Guard</h3>
        <span className="rounded-md bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold text-brand-500">PRO</span>
        {savedTick && <span className="text-xs text-green-500">saved</span>}
      </div>
      <p className="mb-4 text-sm text-text-muted">
        Some upstreams answer HTTP 200 with an empty body or a degenerate repetition loop
        (&quot;OK.OK.OK...&quot;). The guard inspects each finished response and retries on
        another account before anything reaches the client. Fails open — after the retries
        run out, the last response is passed through untouched; long live streams are never held up.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!loaded}
            onChange={(e) => save({ antiFlakyEnabled: e.target.checked }, () => setEnabled(e.target.checked))}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          Max retries
          <select
            value={maxRetries}
            disabled={!loaded || !enabled}
            onChange={(e) => save({ antiFlakyMaxRetries: Number(e.target.value) }, () => setMaxRetries(Number(e.target.value)))}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="text-xs text-text-muted">Recovered responses carry an <span className="font-mono">x-9router-pro-flaky-retries</span> header.</span>
      </div>
    </Card>
  );
}

export default function TokenSaverPro() {
  return (
    <div className="space-y-6 px-6 pb-6">
      <SavingsPanel />
      <BriefMode />
      <TestBench />
      <AntiFlakyCard />
    </div>
  );
}
