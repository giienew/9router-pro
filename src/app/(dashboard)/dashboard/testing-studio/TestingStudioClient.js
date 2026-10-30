"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Select } from "@/shared/components";

// Testing Studio (P3-29): side-by-side comparison of two chat targets
// (models or combos) through the router's own /v1/chat/completions
// endpoint, so routing, caps and usage accounting apply exactly as for
// any client. No new backend: the page is a dashboard-authenticated
// client of the public LLM API. An API key is only needed when the
// router requires one; it lives in this page's memory and is never
// stored. Runs count toward the key's quota like any other request.

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

async function runOne(target, prompt, apiKey, maxTokens) {
  const started = performance.now();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model: target,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  const parsed = parseInt(maxTokens, 10);
  if (Number.isFinite(parsed) && parsed > 0) body.max_tokens = parsed;
  try {
    const res = await fetch("/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const ms = Math.round(performance.now() - started);
    if (!res.ok) {
      const err = data?.error;
      const message = typeof err === "string" ? err : err?.message || data?.message || `Request failed (${res.status})`;
      return { status: "error", target, ms, error: message };
    }
    const choice = data?.choices?.[0];
    return {
      status: "done",
      target,
      served: data?.model || target,
      ms,
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
      text: extractText(choice?.message?.content) || "(empty reply)",
    };
  } catch (e) {
    return { status: "error", target, ms: Math.round(performance.now() - started), error: e?.message || "Network error" };
  }
}

function ResultCard({ label, result }) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{label}</span>
          {result && result.status === "done" && (
            <span className="text-[11px] text-text-muted shrink-0">
              {result.ms} ms
              {result.promptTokens != null && ` · ${result.promptTokens}↑ ${result.completionTokens ?? 0}↓`}
            </span>
          )}
        </div>
        {result?.served && result.served !== result.target && (
          <span className="text-[11px] text-text-muted truncate">Served by {result.served}</span>
        )}
      </div>
      <div className="mt-3 min-h-[120px] whitespace-pre-wrap break-words text-sm">
        {!result && <span className="text-text-muted">No run yet.</span>}
        {result?.status === "error" && <span className="text-red-500">{result.error}</span>}
        {result?.status === "done" && result.text}
      </div>
    </Card>
  );
}

export default function TestingStudioClient() {
  const [options, setOptions] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modelsRes, combosRes] = await Promise.all([
          fetch("/api/models", { cache: "no-store" }),
          fetch("/api/combos", { cache: "no-store" }),
        ]);
        const modelsData = await modelsRes.json().catch(() => ({}));
        const combosData = await combosRes.json().catch(() => ({}));
        const seen = new Set();
        const opts = [];
        for (const c of combosData.combos || []) {
          if (c?.name && !seen.has(c.name)) {
            seen.add(c.name);
            opts.push({ value: c.name, label: `Combo · ${c.name}` });
          }
        }
        for (const m of modelsData.models || []) {
          const value = m?.routedModel || m?.fullModel;
          if (value && !seen.has(value)) {
            seen.add(value);
            opts.push({ value, label: value });
          }
        }
        if (cancelled) return;
        setOptions(opts);
        if (opts.length > 0) setModelA(opts[0].value);
        if (opts.length > 1) setModelB(opts[1].value);
      } catch {
        if (!cancelled) setLoadError("Failed to load models and combos.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const canRun = !running && prompt.trim() && modelA && modelB;

  const handleRun = async () => {
    if (!canRun) return;
    setRunning(true);
    setResults(null);
    const [a, b] = await Promise.all([
      runOne(modelA, prompt.trim(), apiKey.trim(), maxTokens),
      runOne(modelB, prompt.trim(), apiKey.trim(), maxTokens),
    ]);
    setResults({ A: a, B: b });
    setRunning(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask both targets the same thing…"
              rows={4}
              className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/50 dark:border-white/10"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Target A"
              options={options}
              value={modelA}
              onChange={(e) => setModelA(e.target.value)}
            />
            <Select
              label="Target B"
              options={options}
              value={modelB}
              onChange={(e) => setModelB(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="API key (optional)"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Only needed if the router requires an API key"
            />
            <Input
              label="Max output tokens"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="1024"
            />
          </div>
          {loadError && <p className="text-xs text-red-500">{loadError}</p>}
          <Button onClick={handleRun} disabled={!canRun} size="sm">
            {running ? "Running…" : "Run side by side"}
          </Button>
          <p className="text-[11px] text-text-muted">
            Runs go through the router&apos;s own /v1/chat/completions endpoint, so routing, caps and usage
            accounting apply exactly as for any client — and count toward the key&apos;s quota. The key is kept
            only in this page&apos;s memory and is never stored.
          </p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <ResultCard label={modelA ? `A · ${modelA}` : "A"} result={results?.A || null} />
        <ResultCard label={modelB ? `B · ${modelB}` : "B"} result={results?.B || null} />
      </div>
    </div>
  );
}
