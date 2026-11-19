// pro.29 item G — month-scope usage toggle: getUsageStats("month") sums the
// current calendar month to date from the daily rollups, the stats/chart
// routes accept the period, and the usage page + UsageStats offer it next
// to All. Run: npx vitest run unit/pro29-item-g-month-usage.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-month-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed() {
  const db = await import("@/lib/db/index.js");
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12, 0, 0);
  await db.saveRequestUsage({
    provider: "openai", model: "gpt-4", connectionId: "c1",
    tokens: { prompt_tokens: 100, completion_tokens: 50 },
    endpoint: "/v1/chat", status: "ok",
    timestamp: now.toISOString(),
  });
  await db.saveRequestUsage({
    provider: "openai", model: "gpt-4", connectionId: "c1",
    tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    endpoint: "/v1/chat", status: "ok",
    timestamp: prevMonth.toISOString(),
  });
  return { dayOfMonth: now.getDate() };
}

describe("month-scope usage", () => {
  it("getUsageStats('month') counts only this calendar month, 'all' counts everything", async () => {
    await seed();
    const db = await import("@/lib/db/index.js");
    const month = await db.getUsageStats("month");
    expect(month.totalRequests).toBe(1);
    expect(month.totalPromptTokens).toBe(100);
    expect(month.totalCompletionTokens).toBe(50);
    const all = await db.getUsageStats("all");
    expect(all.totalRequests).toBe(2);
    expect(all.totalPromptTokens).toBe(1100);
    expect(all.totalCompletionTokens).toBe(550);
  });

  it("getChartData('month') has one bucket per elapsed day, ending today", async () => {
    const { dayOfMonth } = await seed();
    const db = await import("@/lib/db/index.js");
    const series = await db.getChartData("month");
    expect(series).toHaveLength(dayOfMonth);
    expect(series.reduce((a, b) => a + b.tokens, 0)).toBe(150);
    expect(series[series.length - 1].tokens).toBe(150);
  });

  it("GET /api/usage/stats accepts period=month and rejects unknown periods", async () => {
    await seed();
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    const res = await GET(new Request("http://localhost/api/usage/stats?period=month"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalRequests).toBe(1);
    expect(body.totalPromptTokens).toBe(100);
    const bad = await GET(new Request("http://localhost/api/usage/stats?period=bogus"));
    expect(bad.status).toBe(400);
  });

  it("usage page, UsageStats, chart route and latency card all know 'month'", () => {
    expect(read("src/app/(dashboard)/dashboard/usage/page.js")).toContain('{ value: "month", label: "Month" }');
    expect(read("src/shared/components/UsageStats.js")).toContain('{ value: "month", label: "Month" }');
    expect(read("src/app/api/usage/chart/route.js")).toContain('"month"');
    expect(read("src/app/(dashboard)/dashboard/usage/components/LatencyCard.js")).toContain('month: "month"');
    expect(read("src/app/api/usage/latency/route.js")).toContain('period === "month"');
  });
});
