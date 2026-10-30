"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Card, Button } from "@/shared/components";

// Advisor sections for the Combos page (R1 free stack + R4 tiered draft).
// Both show a dry-run preview first; nothing is created until Apply.
// Flat styling, shared Card/Button tokens.
function AdvisorCard({ title, desc, mode, defaultName }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const preview = async (probe) => {
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/combos/advisor?mode=${mode}${probe ? "&probe=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setData(json);
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };

  const apply = async () => {
    if (!data) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/combos/advisor", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, name: defaultName, apply: true, applyHolding: mode === "free" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setMsg(`Created combo "${json.created?.name || defaultName}". Refresh the page to see it.`);
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };

  const draft = data?.draft;
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-text-muted mt-1">{desc}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => preview(false)} disabled={busy}>Preview draft</Button>
        <Button size="sm" variant="outline" onClick={() => preview(true)} disabled={busy}>Probe + preview</Button>
        {draft && draft.members?.length > 0 && (
          <Button size="sm" onClick={apply} disabled={busy}>Apply — create “{defaultName}”</Button>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-text-muted">{msg}</p>}
      {data && (
        <div className="mt-3 text-xs">
          <p className="text-text-muted">
            {data.candidateCount} chat candidates from your own active providers
            {data.probed?.length ? ` · probed ${data.probed.length} provider(s) live` : ""} · would create “{data.preview?.proposedName}”
            {!data.preview?.wouldCreate ? " (already exists — apply will refuse)" : ""}
          </p>
          {draft?.tiers && (
            <p className="mt-1">Quality: {draft.tiers.quality || "—"} · Fast: {draft.tiers.fast || "—"} · Free: {draft.tiers.free || "—"}</p>
          )}
          <ol className="mt-2 flex flex-col gap-1">
            {(draft?.members || []).map((m, i) => (
              <li key={m} className="rounded border border-black/10 px-2 py-1 dark:border-white/10">{i + 1}. {m}</li>
            ))}
          </ol>
          {(draft?.holding || []).length > 0 && (
            <p className="mt-2 text-text-muted">Cooldown holding (rate-limited, kept out of the live stack): {draft.holding.join(", ")}</p>
          )}
          {(draft?.members || []).length === 0 && (
            <p className="mt-2">No healthy candidates yet — connect a provider and use its Test button first.</p>
          )}
        </div>
      )}
    </Card>
  );
}

AdvisorCard.propTypes = {
  title: PropTypes.string.isRequired,
  desc: PropTypes.string.isRequired,
  mode: PropTypes.string.isRequired,
  defaultName: PropTypes.string.isRequired,
};

export function FreeStackAdvisor() {
  return (
    <AdvisorCard
      mode="free"
      defaultName="free-stack"
      title="Free stack (auto-curated)"
      desc="A ranked combo built only from your own connected free providers, refreshed by an hourly watchdog draft. Preview first — nothing applies until you press Apply."
    />
  );
}

export function ComboAdvisorSection() {
  return (
    <AdvisorCard
      mode="tiered"
      defaultName="advisor-tiered"
      title="Combo advisor"
      desc="One-time proposal: one quality, one fast and one free member, deduplicated across duplicate accounts, chat models only. This proposes a draft; serving-time auto-routing is separate."
    />
  );
}
