// 9Router Pro — Token Saver tests: Brief Mode resolution + RTK savings
// aggregation (pure logic). Run: npx vitest run pro/token-saver.test.js
import assert from "node:assert";
import { selectBriefLevel } from "@/lib/db/repos/briefModeRepo.js";
import { mergeDayStats } from "@/lib/db/repos/tokenSaverStatsRepo.js";

describe("selectBriefLevel — precedence", () => {
  const data = {
    global: "lite",
    byKey: { "key-1": "full" },
    byModel: { "my-model": "ultra", "prov/shared": "full", shared: "lite" },
  };

  it("model beats key beats global", () => {
    assert.equal(selectBriefLevel(data, { apiKeyId: "key-1", requestedModel: "my-model" }), "ultra");
    assert.equal(selectBriefLevel(data, { apiKeyId: "key-1", requestedModel: "other" }), "full");
    assert.equal(selectBriefLevel(data, { apiKeyId: "key-2", requestedModel: "other" }), "lite");
  });

  it("model match order: requested → resolved → bare", () => {
    assert.equal(selectBriefLevel(data, { requestedModel: "x", resolvedModel: "prov/shared", bareModel: "shared" }), "full");
    assert.equal(selectBriefLevel(data, { requestedModel: "x", resolvedModel: "prov/other", bareModel: "shared" }), "lite");
  });

  it("nothing set → null; invalid levels ignored", () => {
    assert.equal(selectBriefLevel({ global: null, byKey: {}, byModel: {} }, { apiKeyId: "k" }), null);
    assert.equal(selectBriefLevel({ global: "banana", byKey: {}, byModel: {} }, {}), null);
    assert.equal(selectBriefLevel(null, {}), null);
  });
});

describe("mergeDayStats — aggregation", () => {
  it("accumulates requests, bytes and per-filter hits", () => {
    let day = mergeDayStats(null, { bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "git-diff", saved: 600 }] });
    assert.equal(day.requests, 1);
    assert.equal(day.bytesBefore, 1000);
    assert.equal(day.bytesAfter, 400);
    assert.equal(day.hits, 1);
    assert.deepEqual(day.filters["git-diff"], { hits: 1, saved: 600 });

    day = mergeDayStats(day, { bytesBefore: 500, bytesAfter: 100, hits: [{ filter: "git-diff", saved: 300 }, { filter: "dedup-log", saved: 100 }] });
    assert.equal(day.requests, 2);
    assert.equal(day.bytesBefore, 1500);
    assert.equal(day.hits, 3);
    assert.deepEqual(day.filters["git-diff"], { hits: 2, saved: 900 });
    assert.deepEqual(day.filters["dedup-log"], { hits: 1, saved: 100 });
  });

  it("tolerates empty hits and missing fields", () => {
    const day = mergeDayStats(undefined, { bytesBefore: 10, bytesAfter: 10, hits: [] });
    assert.equal(day.requests, 1);
    assert.equal(day.hits, 0);
  });
});
