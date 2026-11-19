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
    // Combo context-window mode (rival-ref sweep 2026-11-19): "min" |
    // "max" | "custom". Legacy rows (NULL) read as "min". contextWindow
    // is the custom advertised window (tokens) when mode is "custom".
    contextWindowMode: typeof row.contextWindowMode === "string" && COMBO_CONTEXT_WINDOW_MODES.includes(row.contextWindowMode)
      ? row.contextWindowMode
      : "min",
    contextWindow: Number.isFinite(row.contextWindow) && row.contextWindow > 0 ? Math.floor(row.contextWindow) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Context-window modes a combo can advertise (rival-ref sweep
// 2026-11-19, Go's combo context-window mode): "min" (default) = the
// smallest member's window; "max" = the largest member's window;
// "custom" = the stored contextWindow value.
export const COMBO_CONTEXT_WINDOW_MODES = ["min", "max", "custom"];

// Normalize a (mode, value) pair from an API body. Invalid modes fall
// back to "min"; a custom mode without a positive integer value also
// falls back to "min" (never store an unusable custom window).
export function cleanComboContextWindow(mode, value) {
  const m = COMBO_CONTEXT_WINDOW_MODES.includes(mode) ? mode : "min";
  if (m !== "custom") return { contextWindowMode: m, contextWindow: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { contextWindowMode: "min", contextWindow: null };
  return { contextWindowMode: "custom", contextWindow: Math.floor(n) };
}

// Resolve a combo's advertised context window from its members' windows
// and its stored mode. minWindow/maxWindow are the smallest/largest
// member windows (finite numbers or Infinity/-Infinity when unknown).
// Returns undefined when nothing can be promised.
export function resolveComboContextWindow(mode, customValue, minWindow, maxWindow) {
  if (mode === "custom" && Number.isFinite(customValue) && customValue > 0) {
    return customValue;
  }
  if (mode === "max" && Number.isFinite(maxWindow)) {
    return maxWindow;
  }
  return Number.isFinite(minWindow) ? minWindow : undefined;
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
  const cw = cleanComboContextWindow(data.contextWindowMode, data.contextWindow);
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    prompt: data.prompt || null,
    contextWindowMode: cw.contextWindowMode,
    contextWindow: cw.contextWindow,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, prompt, contextWindowMode, contextWindow, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.prompt ? stringifyJson(combo.prompt) : null, combo.contextWindowMode, combo.contextWindow, combo.createdAt, combo.updatedAt]
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
    // keep the old value). NULL clears the prompt. Same for the
    // context-window mode/value: clean them so a bad mode can never
    // persist as an unusable custom window.
    const cw = cleanComboContextWindow(merged.contextWindowMode, merged.contextWindow);
    merged.contextWindowMode = cw.contextWindowMode;
    merged.contextWindow = cw.contextWindow;
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, prompt = ?, contextWindowMode = ?, contextWindow = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.prompt ? stringifyJson(merged.prompt) : null, merged.contextWindowMode, merged.contextWindow, merged.updatedAt, id]
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
