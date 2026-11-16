import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { invalidateModelsListCache } from "../../../sse/services/modelsListCache.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    // Combo-level prompt injection (issue #2): entry JSON or null.
    // Legacy rows (pre-migration) have a NULL column and read as null.
    prompt: parseJson(row.prompt, null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    prompt: data.prompt || null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, prompt, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.prompt ? stringifyJson(combo.prompt) : null, combo.createdAt, combo.updatedAt]
  );
  invalidateModelsListCache();
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    // prompt MUST be in the SET list: without it a PUT silently drops
    // the prompt (the merged object would carry it, but the row would
    // keep the old value). NULL clears the prompt.
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, prompt = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.prompt ? stringifyJson(merged.prompt) : null, merged.updatedAt, id]
    );
    result = merged;
  });
  if (result) invalidateModelsListCache();
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  const ok = (res?.changes ?? 0) > 0;
  if (ok) invalidateModelsListCache();
  return ok;
}
