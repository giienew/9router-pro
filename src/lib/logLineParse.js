// Parse one raw console line (as captured by consoleLogBuffer) into the
// parts the Console Log panel renders MatLog-style (9Router Pro): time,
// level badge, short tag, session dot, message. The logger's line shapes:
//
//   [23:13:18] ℹ️  [COMBO] trying model 1 of 2: ...
//   [23:13:18] 🟢 ▶ POST dpsk_un → dahl/... · stream · key Key 45
//   [23:13:18] 🔴 ✗ ERROR 402 · dahl/... · quota exhausted · 2.6s
//   [23:13:18] ⚪ 📊 done · 1.3s · in 45,231 · out 87
//   ❌ dahl [402]: quota exhausted
//
// Anything unrecognized degrades to a neutral row carrying the raw text,
// so no console output is ever lost or hidden by the parser.

const DOT_COLORS = {
  "🟢": "#22c55e",
  "🔵": "#3b82f6",
  "🟣": "#a855f7",
  "🟡": "#eab308",
  "🟠": "#f97316",
  "🔴": "#ef4444",
  "⚪": "#e5e7eb",
  "🟤": "#b45309",
};

const SYMBOL_TAGS = {
  "▶": "REQ",
  "✗": "ERR",
  "📊": "DONE",
  "⚙": "PRO",
  "📥": "HTTP",
  "📤": "HTTP",
  "💥": "ERR",
};

export function parseConsoleLine(raw) {
  const line = String(raw ?? "");
  let rest = line.trim();
  let time = "";

  const timeMatch = rest.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*/);
  if (timeMatch) {
    time = timeMatch[1];
    rest = rest.slice(timeMatch[0].length);
  }

  // Session dot (logger line()/errorLine()): same request → same color.
  let dot = "";
  for (const [emoji, hex] of Object.entries(DOT_COLORS)) {
    if (rest.startsWith(emoji)) {
      dot = hex;
      rest = rest.slice(emoji.length).trimStart();
      break;
    }
  }

  // Level icons from the tag logger (info/warn/error/debug).
  let level = "";
  if (/^ℹ️?/.test(rest)) { level = "I"; rest = rest.replace(/^ℹ️?\s*/, ""); }
  else if (/^⚠️?/.test(rest)) { level = "W"; rest = rest.replace(/^⚠️?\s*/, ""); }
  else if (rest.startsWith("❌")) { level = "E"; rest = rest.replace(/^❌\s*/, ""); }
  else if (rest.startsWith("🔍")) { level = "D"; rest = rest.replace(/^🔍\s*/, ""); }

  // Symbol from line()/errorLine() and the request/response loggers.
  let symbol = "";
  const symMatch = rest.match(/^(▶|✗|📊|⚙|✔|📥|📤|💥|🌊)\s*/);
  if (symMatch) {
    symbol = symMatch[1];
    rest = rest.slice(symMatch[0].length);
  }

  // [TAG] from the tag logger, when present.
  let tag = "";
  const tagMatch = rest.match(/^\[([A-Za-z0-9_ -]{1,24})\]\s*/);
  if (tagMatch) {
    tag = tagMatch[1];
    rest = rest.slice(tagMatch[0].length);
  }

  // Plain console.error shape: "dahl [402]: quota exhausted" — the
  // provider becomes the tag so the row stays scannable.
  if (!tag) {
    const provMatch = rest.match(/^([A-Za-z0-9_-]+) \[(\d{3})\]:\s*(.*)$/);
    if (provMatch) {
      tag = provMatch[1].toUpperCase();
      rest = `${provMatch[2]} · ${provMatch[3]}`;
    }
  }

  if (!tag && symbol) tag = SYMBOL_TAGS[symbol] || "";

  if (!level) {
    if (symbol === "✗" || symbol === "💥" || /^ERROR\b/.test(rest)) level = "E";
    else if (symbol === "📊" || symbol === "✔") level = "✓";
    else if (symbol || dot || tag) level = "I";
    else level = "·";
  }

  return { time, level, tag, dot, message: rest.trim() || line.trim() };
}
