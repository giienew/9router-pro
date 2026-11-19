// 003-combo-context-window.js — combo context-window mode columns.
//
// Rival-ref sweep (2026-11-19): Go's combo context-window mode (min/max/
// custom). Adds contextWindowMode + contextWindow to combos. Idempotent:
// syncSchemaFromTables() in migrate.js already auto-adds declared columns,
// this migration is the explicit, guarded record of the change (same
// pattern as 002-combo-prompt.js).
export default {
  version: 3,
  name: "combo-context-window",
  up(db) {
    const cols = db.all(`PRAGMA table_info(combos)`);
    // See 002: a legacy DB may have no combos table yet; the additive
    // sync creates it with all columns, so skip the ALTERs here.
    if (cols.length === 0) return;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("contextWindowMode")) {
      db.exec(`ALTER TABLE combos ADD COLUMN contextWindowMode TEXT`);
    }
    if (!names.has("contextWindow")) {
      db.exec(`ALTER TABLE combos ADD COLUMN contextWindow INTEGER`);
    }
  },
};
