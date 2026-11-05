// Guards the M-1 bulk cap: every bulk-import surface caps at 50 items per
// request, mirroring the live-only Kiro cap (MAX_KIRO_BULK_ITEMS = 50).
import { describe, it, expect } from "vitest";
import { MAX_BULK_IMPORT_ITEMS } from "../../src/lib/oauth/bulkImport.js";

describe("M-1 bulk cap", () => {
  it("caps every bulk import at 50 items per request", () => {
    expect(MAX_BULK_IMPORT_ITEMS).toBe(50);
  });
});
