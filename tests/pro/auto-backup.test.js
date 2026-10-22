// 9Router Pro — backup summary + retention helpers (pure).
import {
  payloadSections,
  sanitizeSections,
  sanitizeProviders,
  BACKUP_GROUP_IDS,
  isBackupPayload,
  summarizeBackup,
  normalizeKeep,
  pruneSnapshotList,
  DEFAULT_KEEP,
} from "../../src/lib/backup/summary.js";

describe("isBackupPayload", () => {
  it("accepts the format marker", () => {
    expect(isBackupPayload({ format: "9router-backup" })).toBe(true);
  });
  it("accepts legacy payloads with a connections array", () => {
    expect(isBackupPayload({ providerConnections: [] })).toBe(true);
  });
  it("rejects non-backups", () => {
    expect(isBackupPayload(null)).toBe(false);
    expect(isBackupPayload([])).toBe(false);
    expect(isBackupPayload({ hello: 1 })).toBe(false);
    expect(isBackupPayload("x")).toBe(false);
  });
});

describe("summarizeBackup", () => {
  const payload = {
    format: "9router-backup",
    appVersion: "0.5.104-pro.5",
    exportedAt: "2026-10-22T00:00:00.000Z",
    providerConnections: [{ id: 1 }, { id: 2 }],
    providerNodes: [{ id: 1 }],
    apiKeys: [{ id: 1 }, { id: 2 }, { id: 3 }],
    combos: [{ id: 1 }],
    proxyPools: [],
    customModels: [{}, {}],
    promptInjections: {
      global: { mode: "single", content: "g" },
      prompts: {
        a_un: { mode: "single", content: "a" },
        empty_one: {},
        chatty: { mode: "chat", turns: [{ role: "user", content: "hi" }] },
      },
      byKey: { k1: { mode: "single", content: "k" }, k2: {} },
      byKeyModel: { k1: { m1: { mode: "single", content: "km" } } },
    },
    promptPresets: { list: [{ id: "t1" }, { id: "t2" }] },
  };

  it("counts every section", () => {
    const s = summarizeBackup(payload);
    expect(s.valid).toBe(true);
    expect(s.appVersion).toBe("0.5.104-pro.5");
    expect(s.counts).toEqual({
      connections: 2,
      providerNodes: 1,
      apiKeys: 3,
      combos: 1,
      proxyPools: 0,
      customModels: 2,
      injections: 5, // global + a_un + chatty + byKey k1 + byKeyModel m1 (empties skipped)
      templates: 2,
    });
  });

  it("summarizes garbage as invalid with zero counts", () => {
    const s = summarizeBackup({ nope: true });
    expect(s.valid).toBe(false);
    expect(s.counts.connections).toBe(0);
    expect(s.counts.injections).toBe(0);
  });

  it("tolerates missing sections", () => {
    const s = summarizeBackup({ format: "9router-backup" });
    expect(s.valid).toBe(true);
    expect(s.counts.templates).toBe(0);
  });
});

describe("normalizeKeep", () => {
  it("defaults and clamps", () => {
    expect(normalizeKeep(undefined)).toBe(DEFAULT_KEEP);
    expect(normalizeKeep("x")).toBe(DEFAULT_KEEP);
    expect(normalizeKeep(0)).toBe(1);
    expect(normalizeKeep(7)).toBe(7);
    expect(normalizeKeep(99)).toBe(30);
    expect(normalizeKeep("14")).toBe(14);
  });
});

describe("pruneSnapshotList", () => {
  const mk = (day) => ({ id: `s${day}`, createdAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z` });

  it("keeps the newest N, sorted newest first", () => {
    const { keep, remove } = pruneSnapshotList([mk(1), mk(5), mk(3)], 2);
    expect(keep.map((e) => e.id)).toEqual(["s5", "s3"]);
    expect(remove.map((e) => e.id)).toEqual(["s1"]);
  });

  it("keeps everything when under the limit", () => {
    const { keep, remove } = pruneSnapshotList([mk(1)], 7);
    expect(keep.length).toBe(1);
    expect(remove.length).toBe(0);
  });
});

describe("payloadSections", () => {
  it("returns all groups for a legacy full backup (no declaration)", () => {
    expect(payloadSections({ format: "9router-backup" })).toEqual(BACKUP_GROUP_IDS);
  });
  it("returns the declared subset, dropping unknown ids and dupes", () => {
    expect(payloadSections({ sections: ["combos", "nope", "combos", "apiKeys"] })).toEqual(["combos", "apiKeys"]);
  });
  it("falls back to all groups when the declaration is unusable", () => {
    expect(payloadSections({ sections: ["nope"] })).toEqual(BACKUP_GROUP_IDS);
    expect(payloadSections({ sections: "combos" })).toEqual(BACKUP_GROUP_IDS);
    expect(payloadSections(null)).toEqual(BACKUP_GROUP_IDS);
  });
});

describe("sanitizeSections", () => {
  it("keeps valid unique ids", () => {
    expect(sanitizeSections(["combos", "combos", "settings"])).toEqual(["combos", "settings"]);
  });
  it("returns null for empty or unusable input (null means all)", () => {
    expect(sanitizeSections([])).toBe(null);
    expect(sanitizeSections(["nope"])).toBe(null);
    expect(sanitizeSections(undefined)).toBe(null);
  });
});

describe("sanitizeProviders", () => {
  it("trims, dedupes and drops empties", () => {
    expect(sanitizeProviders([" dahl ", "dahl", "", "codex"])).toEqual(["dahl", "codex"]);
  });
  it("returns null for unusable input", () => {
    expect(sanitizeProviders([])).toBe(null);
    expect(sanitizeProviders("dahl")).toBe(null);
    expect(sanitizeProviders([42, null])).toBe(null);
  });
});

describe("summarizeBackup selective declarations", () => {
  it("exposes sections and providers, and flags provider-scoped files partial", () => {
    const s = summarizeBackup({
      format: "9router-backup",
      providerConnections: [{ provider: "dahl" }],
      providers: ["dahl"],
    });
    expect(s.valid).toBe(true);
    expect(s.providers).toEqual(["dahl"]);
    expect(s.partial).toBe(true);
    expect(s.sections).toEqual(BACKUP_GROUP_IDS);
  });
  it("flags a section subset partial and a full file not partial", () => {
    const sub = summarizeBackup({ format: "9router-backup", sections: ["combos"] });
    expect(sub.sections).toEqual(["combos"]);
    expect(sub.partial).toBe(true);
    const full = summarizeBackup({ format: "9router-backup", providerConnections: [] });
    expect(full.partial).toBe(false);
    expect(full.providers).toBe(null);
  });
});
