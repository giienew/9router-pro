"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input } from "@/shared/components";

// R14 eval runner UI: saved prompt sets + per-model pass-rate results
// table. Deliberately NOT a side-by-side chat page: no comparison columns,
// no live chat — one run, one model, one scored table. The API key typed
// for a run is sent only for that run and is never stored.
export default function EvalsPage() {
  const [sets, setSets] = useState([]);
  const [runs, setRuns] = useState([]);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [promptsText, setPromptsText] = useState("");
  const [runSetId, setRunSetId] = useState("");
  const [runModel, setRunModel] = useState("");
  const [runKey, setRunKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/evals");
      const data = await res.json();
      setSets(data.sets || []);
      setRuns(data.runs || []);
    } catch {}
  };
  useEffect(() => { load(); }, []);

  const createSet = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/evals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name, model: model || null, promptsText }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMsg(`Set "${data.set.name}" saved with ${data.set.prompts.length} prompt(s).`);
      setName(""); setModel(""); setPromptsText("");
      load();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };

  const runSet = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/evals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", setId: runSetId, model: runModel || null, apiKey: runKey }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMsg(`Run finished: ${data.run.passed}/${data.run.scored} passed${data.run.passRate != null ? ` (${Math.round(data.run.passRate * 100)}%)` : ""}.`);
      load();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div>
        <h1 className="text-lg font-semibold">Eval Runner</h1>
        <p className="text-sm text-text-muted mt-1">Saved prompt sets scored against expected outputs, per model. Re-run after a routing or model change to catch regressions. This is a scored table, not a chat comparison page.</p>
      </div>
      {msg && <p className="text-sm text-text-muted">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">New golden set</h2>
          <div className="mt-3 flex flex-col gap-2">
            <Input label="Set name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. support-regression" />
            <Input label="Default model (optional)" value={model} onChange={(e) => setModel(e.target.value)} placeholder="combo or provider/model" />
            <label className="flex flex-col gap-1 text-xs text-text-muted">Prompts — one per line, “prompt || expected substring” (expected optional)
              <textarea value={promptsText} onChange={(e) => setPromptsText(e.target.value)} rows={6} placeholder={"What is 2+2? || 4\nSay hello || hello"} className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px] text-text-main" />
            </label>
            <Button onClick={createSet} disabled={busy || !name.trim() || !promptsText.trim()}>Save set</Button>
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Run a set</h2>
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-text-muted">Set
              <select value={runSetId} onChange={(e) => setRunSetId(e.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main">
                <option value="">Choose a set…</option>
                {sets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.prompts.length} prompts)</option>)}
              </select>
            </label>
            <Input label="Model override (optional — else the set's model)" value={runModel} onChange={(e) => setRunModel(e.target.value)} placeholder="provider/model or combo" />
            <Input label="API key for this run only (never stored)" type="password" value={runKey} onChange={(e) => setRunKey(e.target.value)} placeholder="sk_9router…" />
            <Button onClick={runSet} disabled={busy || !runSetId || !runKey}>Run + score</Button>
            <p className="text-[11px] text-text-muted">Runs go through your own router (same endpoint as clients) and count against that key&apos;s usage.</p>
          </div>
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Results</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No runs yet.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {runs.map((run) => (
              <div key={run.id}>
                <p className="text-sm font-medium">
                  {sets.find((s) => s.id === run.setId)?.name || run.setId} · {run.model} · {run.passed ?? run.results.filter((r) => r.pass === true).length}/{run.results.filter((r) => r.pass !== null).length} passed
                  {run.passRate != null ? ` (${Math.round(run.passRate * 100)}%)` : ""} · {run.createdAt ? new Date(run.createdAt).toLocaleString() : ""}
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-xs">
                    <thead><tr className="text-text-muted"><th className="py-1 pr-2">Prompt</th><th className="py-1 pr-2">Expected</th><th className="py-1 pr-2">Result</th><th className="py-1">Answer (excerpt)</th></tr></thead>
                    <tbody>
                      {run.results.map((r, i) => (
                        <tr key={i} className="border-t border-black/5 dark:border-white/5">
                          <td className="py-1 pr-2 align-top">{r.prompt}</td>
                          <td className="py-1 pr-2 align-top">{r.expected || "—"}</td>
                          <td className="py-1 pr-2 align-top font-medium">
                            {r.pass === null ? "No expectation" : r.pass ? <span className="text-green-600">PASS</span> : <span className="text-red-600">FAIL{r.error ? ` (${r.error})` : ""}</span>}
                          </td>
                          <td className="py-1 align-top text-text-muted">{(r.answer || "").slice(0, 160)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
