import { describe, it, expect } from "vitest";
import { percentile, computeLatencyStats } from "@/lib/latencyStats.js";

describe("latency stats", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([5], 95)).toBe(5);
  });

  it("aggregates ttft/total overall and per provider", () => {
    const stats = computeLatencyStats([
      { provider: "a", total: 100, ttft: 10 },
      { provider: "a", total: 200, ttft: 20 },
      { provider: "b", total: 300, ttft: 0 },
      { provider: "b", total: 400, ttft: 40 },
      { provider: "b", total: -5, ttft: 5 }, // invalid row: skipped
    ]);
    expect(stats.samples).toBe(4);
    expect(stats.total.p50).toBe(200);
    expect(stats.total.p95).toBe(400);
    expect(stats.ttft.samples).toBe(3);
    expect(stats.ttft.p50).toBe(20);
    expect(stats.byProvider.a.totalP95).toBe(200);
    expect(stats.byProvider.b.ttftP50).toBe(40);
  });

  it("reports zero samples instead of fabricated numbers", () => {
    const stats = computeLatencyStats([]);
    expect(stats.samples).toBe(0);
    expect(stats.total.p50).toBeNull();
    expect(stats.ttft.p95).toBeNull();
  });
});
