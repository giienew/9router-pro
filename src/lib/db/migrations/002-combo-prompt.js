// Combo-level prompt injection (issue #2): `prompt` column on combos,
// holding entry JSON { mode, content, turns, position, enabled } or NULL.
// Idempotent: a fresh DB already gets the column from m001 (TABLES is the
// current schema), so only add it when it is actually missing — otherwise
// the ALTER would fail boot on every fresh install.
export default {
  version: 2,
  name: "combo-prompt",
  up(db) {
    const cols = db.all(`PRAGMA table_info(combos)`);
    // A legacy DB may have no combos table at all (it is created by the
    // additive sync in migrate.js with all columns); ALTER on a missing
    // table fails boot, so skip when the table does not exist yet.
    if (cols.length === 0) return;
    if (!cols.some((c) => c.name === "prompt")) {
      db.exec(`ALTER TABLE combos ADD COLUMN prompt TEXT`);
    }
  },
};
