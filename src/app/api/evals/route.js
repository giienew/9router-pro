import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { scoreAnswer, scoreRun, parsePromptLines } from "@/lib/evalRunner.js";

export const dynamic = "force-dynamic";

function ensureTables(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS evalSets (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, prompts TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS evalRuns (id TEXT PRIMARY KEY, setId TEXT NOT NULL, model TEXT NOT NULL, results TEXT NOT NULL, passRate REAL, createdAt TEXT NOT NULL)`);
  } catch {}
}

// GET /api/evals — saved sets + recent runs (results table data).
export async function GET() {
  try {
    const db = await getAdapter();
    ensureTables(db);
    const sets = (db.all(`SELECT * FROM evalSets ORDER BY updatedAt DESC LIMIT 100`) || []).map((r) => ({ ...r, prompts: parseJson(r.prompts, []) }));
    const runs = (db.all(`SELECT * FROM evalRuns ORDER BY createdAt DESC LIMIT 50`) || []).map((r) => ({ ...r, results: parseJson(r.results, []) }));
    return NextResponse.json({ sets, runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const db = await getAdapter();
    ensureTables(db);

    if (body.action === "create") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const prompts = Array.isArray(body.prompts) ? body.prompts : parsePromptLines(body.promptsText || "");
      if (!name || !prompts.length) return NextResponse.json({ error: "name and at least one prompt are required" }, { status: 400 });
      const clean = prompts.filter((p) => p?.prompt).map((p) => ({ prompt: String(p.prompt).slice(0, 4000), expected: String(p.expected || "").slice(0, 1000) }));
      const now = new Date().toISOString();
      const id = randomUUID();
      db.run(`INSERT INTO evalSets(id, name, model, prompts, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`, [id, name, body.model || null, stringifyJson(clean), now, now]);
      return NextResponse.json({ set: { id, name, model: body.model || null, prompts: clean } }, { status: 201 });
    }

    if (body.action === "delete" && body.setId) {
      db.run(`DELETE FROM evalSets WHERE id = ?`, [body.setId]);
      db.run(`DELETE FROM evalRuns WHERE setId = ?`, [body.setId]);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "run") {
      const set = db.get(`SELECT * FROM evalSets WHERE id = ?`, [body.setId]);
      if (!set) return NextResponse.json({ error: "Eval set not found" }, { status: 404 });
      const model = body.model || set.model;
      if (!model) return NextResponse.json({ error: "No model: pass one for the run or save one on the set" }, { status: 400 });
      // The API key is used ONLY for this run and is never stored.
      const apiKey = body.apiKey || "";
      if (!apiKey) return NextResponse.json({ error: "An API key is required to run (it is not stored)" }, { status: 400 });
      const prompts = parseJson(set.prompts, []);
      const port = Number(process.env.PORT) || 3000;
      const results = [];
      for (const p of prompts) {
        let content = "";
        let error = null;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 120000);
          const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: "user", content: p.prompt }], stream: false }),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          const json = await res.json().catch(() => null);
          content = json?.choices?.[0]?.message?.content || "";
          if (!res.ok) error = json?.error?.message || `HTTP ${res.status}`;
        } catch (e) { error = e?.message || "request failed"; }
        results.push({ prompt: p.prompt, expected: p.expected || "", answer: content.slice(0, 2000), pass: error ? false : scoreAnswer(content, p.expected), error });
      }
      const summary = scoreRun(results);
      const id = randomUUID();
      const now = new Date().toISOString();
      db.run(`INSERT INTO evalRuns(id, setId, model, results, passRate, createdAt) VALUES(?, ?, ?, ?, ?, ?)`, [id, set.id, model, stringifyJson(results), summary.passRate, now]);
      return NextResponse.json({ run: { id, setId: set.id, model, results, ...summary, createdAt: now } }, { status: 201 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
