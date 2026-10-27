import { describe, it, expect } from "vitest";
import { runMaintenance } from "@/lib/db/maintenance.js";

function fakeDb({ vacuumFails = false } = {}) {
  const calls = [];
  return {
    calls,
    run(sql, params = []) {
      calls.push(sql);
      if (sql === "VACUUM") {
        if (vacuumFails) throw new Error("no vacuum here");
        return { changes: 0 };
      }
      if (sql.includes("usageHistory")) return { changes: 12 };
      if (sql.includes("requestDetails")) return { changes: 7 };
      if (sql.includes("responseCache")) return { changes: 3 };
      return { changes: 0 };
    },
  };
}

describe("db maintenance", () => {
  it("prunes history + expired cache and vacuums", async () => {
    const db = fakeDb();
    const out = await runMaintenance(db, { retentionDays: 90 });
    expect(out.prunedUsage).toBe(12);
    expect(out.prunedDetails).toBe(7);
    expect(out.prunedCache).toBe(3);
    expect(out.vacuum).toBe("done");
    expect(out.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.calls.some((s) => s.includes("usageHistory"))).toBe(true);
  });

  it("reports vacuum as skipped instead of failing the run", async () => {
    const db = fakeDb({ vacuumFails: true });
    const out = await runMaintenance(db, { retentionDays: 30 });
    expect(out.vacuum).toBe("skipped");
    expect(out.prunedUsage).toBe(12);
  });
});
