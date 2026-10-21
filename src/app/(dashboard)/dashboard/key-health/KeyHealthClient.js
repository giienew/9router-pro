"use client";

// Key Health (9Router Pro) — pool hygiene UI: health buckets per provider,
// bounded batch testing, and bulk cleanup of dead connections.

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button } from "@/shared/components";

const BUCKETS = [
  { id: "", label: "All" },
  { id: "active", label: "Active" },
  { id: "cooldown", label: "Cooldown" },
  { id: "unavailable", label: "Unavailable" },
  { id: "error", label: "Error" },
  { id: "unknown", label: "Unknown" },
  { id: "disabled", label: "Disabled" },
];

const BADGE = {
  active: "bg-green-500/10 text-green-600 dark:text-green-400",
  cooldown: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  unavailable: "bg-red-500/10 text-red-600 dark:text-red-400",
  error: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  unknown: "bg-gray-500/10 text-gray-500",
  disabled: "bg-gray-500/10 text-gray-400",
};

const PAGE_SIZE = 50;
const TEST_CHUNK = 25;

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function KeyHealthClient() {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const searchTimer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/providers?summary=1");
        if (!r.ok) { setNotice("Failed to load the provider list — refresh to retry."); return; }
        const j = await r.json();
        // stats is an object keyed by "provider|authType" (one entry per
        // auth type) — aggregate totals per provider for the dropdown.
        const raw = j.stats || {};
        const entries = Array.isArray(raw) ? raw : Object.values(raw);
        const byId = new Map();
        for (const s of entries) {
          if (!s?.provider) continue;
          byId.set(s.provider, (byId.get(s.provider) || 0) + (s.total || 0));
        }
        const list = [...byId.entries()].map(([id, total]) => ({ id, total }));
        list.sort((a, b) => b.total - a.total);
        setProviders(list);
        if (list.length) setProvider(list[0].id);
        else setNotice("No providers with connections were found.");
      } catch { setNotice("Failed to load the provider list — refresh to retry."); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ provider, page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) qs.set("status", status);
      if (search.trim()) qs.set("search", search.trim());
      const r = await fetch(`/api/key-health?${qs}`);
      if (r.ok) {
        setData(await r.json());
        setSelected(new Set());
      } else {
        setNotice("Failed to load key health data — refresh to retry.");
      }
    } catch { setNotice("Failed to load key health data — refresh to retry."); }
    setLoading(false);
  }, [provider, status, search, page]);

  useEffect(() => { load(); }, [load]);

  const onSearch = (v) => {
    setSearchInput(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setSearch(v); setPage(1); }, 350);
  };

  const counts = data?.counts || {};
  const rows = data?.connections || [];
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));
  const deadCount = (counts.unavailable || 0) + (counts.error || 0);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const post = async (payload) => {
    const r = await fetch("/api/key-health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok ? r.json() : null;
  };

  const runTests = async (ids, label) => {
    if (!ids.length || busy) return;
    setBusy(label);
    setNotice("");
    let valid = 0;
    let done = 0;
    for (let i = 0; i < ids.length; i += TEST_CHUNK) {
      const chunk = ids.slice(i, i + TEST_CHUNK);
      const res = await post({ action: "test", ids: chunk });
      if (res?.results) {
        valid += res.results.filter((x) => x.valid).length;
        done += res.results.length;
      }
      setNotice(`Testing… ${done}/${ids.length} (${valid} valid)`);
    }
    setBusy("");
    setNotice(`Test done: ${valid}/${ids.length} valid.`);
    load();
  };

  const deleteIds = async (ids) => {
    if (!ids.length || busy) return;
    if (!window.confirm(`Delete ${ids.length} connection(s)? This cannot be undone.`)) return;
    setBusy("delete");
    const res = await post({ action: "delete", ids });
    setBusy("");
    setNotice(res ? `Deleted ${res.deleted} connection(s).` : "Delete failed.");
    load();
  };

  const deleteDead = async () => {
    if (!provider || busy || deadCount === 0) return;
    if (!window.confirm(`Delete ALL ${deadCount} unavailable/error connections for "${provider}"? This cannot be undone.`)) return;
    setBusy("deleteDead");
    const res = await post({ action: "deleteDead", provider });
    setBusy("");
    setNotice(res ? `Deleted ${res.deleted} dead connection(s).` : "Delete failed.");
    setPage(1);
    load();
  };

  return (
    <div className="space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="material-symbols-outlined text-brand-500">monitor_heart</span>
        <h2 className="text-lg font-semibold">Key Health</h2>
        <span className="rounded-md bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold text-brand-500">PRO</span>
        <select
          value={provider}
          onChange={(e) => { setProvider(e.target.value); setPage(1); setStatus(""); }}
          className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
        >
          {providers.length === 0 && <option value="">Loading providers…</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.id} ({p.total})</option>
          ))}
        </select>
        <input
          value={searchInput}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name or email…"
          className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
        />
        {loading && <span className="text-xs text-text-muted">loading…</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        {BUCKETS.map((b) => {
          const n = b.id === "" ? counts.total || 0 : counts[b.id] || 0;
          const activeChip = status === b.id;
          return (
            <button
              key={b.id || "all"}
              type="button"
              onClick={() => { setStatus(b.id); setPage(1); }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${activeChip ? "bg-brand-500 text-white" : "bg-surface-2 text-text-muted hover:text-text-main"}`}
            >
              {b.label} · {n}
            </button>
          );
        })}
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!!busy || !rows.length} onClick={() => runTests(rows.map((r) => r.id), "testPage")}>
            Test this page ({rows.length})
          </Button>
          <Button size="sm" disabled={!!busy || selected.size === 0} onClick={() => runTests([...selected], "testSel")}>
            Test selected ({selected.size})
          </Button>
          <Button size="sm" disabled={!!busy || selected.size === 0} onClick={() => deleteIds([...selected])}>
            Delete selected
          </Button>
          <button
            type="button"
            disabled={!!busy || deadCount === 0}
            onClick={deleteDead}
            className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-500 transition-colors hover:bg-red-500/20 disabled:opacity-40"
          >
            Delete all dead ({deadCount})
          </button>
          {notice && <span className="text-xs text-text-muted">{notice}</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last error</th>
                <th className="py-2 pr-3">Last tested</th>
                <th className="py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="py-2 pr-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-mono text-xs">{r.name}</div>
                    {r.email && <div className="text-xs text-text-muted">{r.email}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${BADGE[r.status] || BADGE.unknown}`}>{r.status}</span>
                  </td>
                  <td className="py-2 pr-3 max-w-[280px]">
                    <span className="block truncate text-xs text-text-muted" title={r.lastError || ""}>{r.lastError || "—"}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-text-muted">{fmtTime(r.lastTested)}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => runTests([r.id], "testOne")}
                      className="text-xs font-medium text-brand-500 hover:underline disabled:opacity-40"
                    >
                      Test
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-text-muted">No connections match.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3 text-xs text-text-muted">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
          <span>Page {page} of {totalPages} — {data?.total || 0} keys</span>
          <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </Card>

      <p className="text-xs text-text-muted">
        Buckets come from live connection state: cooldown = rate-limited or model-locked right now;
        unavailable / error = last recorded failure; unknown = never tested and never used.
        Testing runs the same probe as the Providers page and updates each key&apos;s status in place.
      </p>
    </div>
  );
}
