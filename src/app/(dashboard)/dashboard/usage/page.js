"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import UsageStats from "@/shared/components/UsageStats";
import RequestDetailsTab from "./components/RequestDetailsTab";
import LatencyCard from "./components/LatencyCard";
import UsageProofSections from "./components/UsageProof";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [customRange, setCustomRange] = useState(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 6);
    return { start: localDateKey(start), end: localDateKey(end) };
  });

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
            { value: "logs", label: "Logs" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            size="sm"
            className="w-full sm:w-auto"
          />
        )}
      </div>

      {activeTab === "overview" && period === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={customRange.start}
            max={customRange.end}
            onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            aria-label="Start date"
          />
          <span className="text-sm text-text-muted">to</span>
          <input
            type="date"
            value={customRange.end}
            min={customRange.start}
            onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            aria-label="End date"
          />
          <span className="text-xs text-text-muted">Whole days, from daily rollups.</span>
        </div>
      )}

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats
            period={period}
            setPeriod={setPeriod}
            hidePeriodSelector
            range={period === "custom" ? customRange : null}
          />
          <LatencyCard period={period} />
          <UsageProofSections />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && (
        <>
          <p className="text-xs text-text-muted">
            Details — a per-request breakdown (tokens, cost, timing). For the raw one-line log,
            see <a href="/dashboard/usage?tab=logs" className="font-medium text-primary hover:underline">Usage → Logs</a>;
            for server console output, see <a href="/dashboard/console-log" className="font-medium text-primary hover:underline">Console Log</a>.
          </p>
          <RequestDetailsTab />
        </>
      )}
    </div>
  );
}
