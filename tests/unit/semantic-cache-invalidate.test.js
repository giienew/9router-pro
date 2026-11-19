// Semantic-cache invalidate: POST /api/cache/semantic/invalidate clears the
// entries (all, or one model) and reports how many were removed.
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  putSemanticEntry,
  getSemanticEntries,
  invalidateSemanticEntries,
} from "../../src/lib/semanticCache.js";

// In-memory stand-in for the DB adapter (same run/get/all surface).
function memoryDb() {
  const raw = new DatabaseSync(":memory:");
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
  };
}

describe("invalidateSemanticEntries", () => {
  it("removes every entry and reports the count", async () => {
    const db = memoryDb();
    await putSemanticEntry(db, "scope-a", "dahl/deepseek-v2", "hello world", { ok: 1 });
    await putSemanticEntry(db, "scope-a", "oneover/gpt-5.4-nano", "hello there", { ok: 1 });
    await putSemanticEntry(db, "scope-b", "dahl/deepseek-v2", "hello again", { ok: 1 });

    expect(invalidateSemanticEntries(db)).toBe(3);
    expect(await getSemanticEntries(db, "scope-a", "dahl/deepseek-v2")).toHaveLength(0);
    expect(await getSemanticEntries(db, "scope-a", "oneover/gpt-5.4-nano")).toHaveLength(0);
    expect(invalidateSemanticEntries(db)).toBe(0);
  });

  it("removes only the given model's entries", async () => {
    const db = memoryDb();
    await putSemanticEntry(db, "scope-a", "dahl/deepseek-v2", "hello world", { ok: 1 });
    await putSemanticEntry(db, "scope-a", "oneover/gpt-5.4-nano", "hello there", { ok: 1 });

    expect(invalidateSemanticEntries(db, "dahl/deepseek-v2")).toBe(1);
    expect(await getSemanticEntries(db, "scope-a", "dahl/deepseek-v2")).toHaveLength(0);
    expect(await getSemanticEntries(db, "scope-a", "oneover/gpt-5.4-nano")).toHaveLength(1);
  });

  it("returns 0 on an empty cache and on a missing db", async () => {
    const db = memoryDb();
    expect(invalidateSemanticEntries(db)).toBe(0);
    expect(invalidateSemanticEntries(db, "dahl/deepseek-v2")).toBe(0);
    expect(invalidateSemanticEntries(null)).toBe(0);
  });
});
