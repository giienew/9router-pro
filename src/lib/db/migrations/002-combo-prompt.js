// Combo-level prompt injection (issue #2): `prompt` column on combos,
// holding entry JSON { mode, content, turns, position, enabled } or NULL.
// Idempotent: a fresh DB already gets the column from m001 (TABLES is the
// current schema), so only add it when it is actually missing — otherwise
// the ALTER would fail boot on every fresh install.
export default {
  version: 2,
  name: "combo-prompt",
  up(db) {
    // A DB stamped v1 that never ran m001 (or lost the table) has no combos
    // table at all: PRAGMA table_info would come back empty and the ALTER
    // below would crash boot with "no such table: combos". Skip in that
    // case — syncSchemaFromTables runs after migrations and creates the
    // table from TABLES, which already includes the prompt column.
    const table = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'combos'`);
    if (!table) return;
    const cols = db.all(`PRAGMA table_info(combos)`);
    if (!cols.some((c) => c.name === "prompt")) {
      db.exec(`ALTER TABLE combos ADD COLUMN prompt TEXT`);
    }
  },
};
