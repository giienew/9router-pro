// Guards the bulk-add speedup: runBulkPool must overlap per-key work with a
// bounded number of workers (browsers cap same-origin connections around 6),
// count success/failed exactly like the old sequential loop, and report
// progress up to the full total.
import { describe, it, expect } from "vitest";
import { runBulkPool } from "../../src/shared/utils/bulkAdd.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("runBulkPool: bounded parallel bulk work", () => {
  it("processes every entry exactly once", async () => {
    const seen = [];
    const { success, failed } = await runBulkPool(
      [{ name: "Key 1" }, { name: "Key 2" }, { name: "Key 3" }],
      async (e) => {
        seen.push(e.name);
        return true;
      },
      { concurrency: 6 },
    );
    expect(seen.sort()).toEqual(["Key 1", "Key 2", "Key 3"]);
    expect({ success, failed }).toEqual({ success: 3, failed: 0 });
  });

  it("caps in-flight workers at the requested concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runBulkPool(
      Array.from({ length: 12 }, (_, i) => ({ name: `Key ${i + 1}` })),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(10);
        inFlight--;
        return true;
      },
      { concurrency: 2 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("counts false results and thrown workers as failed", async () => {
    const { success, failed } = await runBulkPool(
      [{ name: "Key 1" }, { name: "Key 2" }, { name: "Key 3" }, { name: "Key 4" }],
      async (e) => {
        if (e.name === "Key 2") return false;
        if (e.name === "Key 3") throw new Error("boom");
        return true;
      },
      { concurrency: 6 },
    );
    expect({ success, failed }).toEqual({ success: 2, failed: 2 });
  });

  it("reports progress up to the full total", async () => {
    const progress = [];
    await runBulkPool(
      [{ name: "Key 1" }, { name: "Key 2" }, { name: "Key 3" }],
      async () => true,
      {
        concurrency: 1,
        onProgress: (p) => progress.push({ ...p }),
      },
    );
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.every((p) => p.total === 3)).toBe(true);
    expect(progress.map((p) => p.current)).toEqual(["Key 1", "Key 2", "Key 3"]);
  });

  it("handles an empty batch without calling the worker", async () => {
    let calls = 0;
    const out = await runBulkPool([], async () => {
      calls++;
      return true;
    });
    expect(out).toEqual({ success: 0, failed: 0 });
    expect(calls).toBe(0);
  });
});
