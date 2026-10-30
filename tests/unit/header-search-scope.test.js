// P2-19: the header search box is scoped to the Providers page — the only
// page that consumes the query. The structural route gate means a stale
// `visible` registration can never render a dead search box elsewhere.
// Run from tests/:
//   bun x vitest run unit/header-search-scope.test.js
import { describe, it, expect } from "vitest";

const { isHeaderSearchPath, HEADER_SEARCH_PATH } = await import("../../src/store/headerSearchStore.js");

describe("header search scope", () => {
  it("admits only the Providers list route", () => {
    expect(HEADER_SEARCH_PATH).toBe("/dashboard/providers");
    expect(isHeaderSearchPath("/dashboard/providers")).toBe(true);
  });

  it("rejects every other dashboard route, including provider detail", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/combos",
      "/dashboard/usage",
      "/dashboard/proxy-pools",
      "/dashboard/providers/dahl",
      "/dashboard/providers/",
      "/dashboard/providers?query=dahl",
      null,
      undefined,
      "",
    ]) {
      expect(isHeaderSearchPath(path)).toBe(false);
    }
  });
});
