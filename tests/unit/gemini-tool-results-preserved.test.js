// Gemini tool results must not be silently dropped on either leg of the
// OpenAI bridge (sweep 2026-11-16, Go translator fixes).
import { describe, expect, it } from "vitest";

import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";

function geminiResponses(out) {
  const resps = [];
  for (const c of out.contents || []) {
    for (const p of c.parts || []) {
      if (p.functionResponse) resps.push(p.functionResponse);
    }
  }
  return resps;
}

describe("openai→gemini: orphaned tool results are still emitted", () => {
  // A role:tool message with no matching assistant tool_calls turn used to
  // vanish: the main loop only emits results piggybacked on their assistant
  // turn. The result must reach the model as its own functionResponse turn.
  it("role:tool with no assistant turn emits a functionResponse", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "run it" },
        { role: "tool", tool_call_id: "call_orphan", content: "orphan output" },
        { role: "user", content: "and then?" },
      ],
    }, false);
    const resps = geminiResponses(out);
    expect(resps.length, "orphan tool result was dropped").toBe(1);
    expect(resps[0].id).toBe("call_orphan");
    expect(JSON.stringify(resps[0].response)).toContain("orphan output");
  });

  // Same for a mismatched id: the assistant turn's call gets the empty
  // placeholder (existing behaviour), but the real result must still be
  // emitted under its own id instead of disappearing.
  it("mismatched tool_call_id still emits the real result", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", tool_calls: [{ id: "call_a", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_b", content: "real output" },
        { role: "user", content: "and then?" },
      ],
    }, false);
    const resps = geminiResponses(out);
    const real = resps.find((r) => JSON.stringify(r.response).includes("real output"));
    expect(real, "mismatched tool result was dropped").toBeDefined();
    expect(real.id).toBe("call_b");
  });
});

describe("gemini→openai: parallel functionResponses all survive", () => {
  // An early return on the first functionResponse used to discard every
  // sibling part: parallel tool calls in one Gemini user turn lost all
  // results after the first, plus any co-located text.
  it("two functionResponses in one content become two tool messages", () => {
    const out = geminiToOpenAIRequest("gemini-2.0-flash", {
      contents: [{
        role: "user",
        parts: [
          { functionResponse: { id: "call_1", name: "bash", response: { result: "one" } } },
          { functionResponse: { id: "call_2", name: "read", response: { result: "two" } } },
        ],
      }],
    }, false);
    const tools = (out.messages || []).filter((m) => m.role === "tool");
    expect(tools.length, "second functionResponse was dropped").toBe(2);
    expect(tools.map((t) => t.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(tools[0].content).toContain("one");
    expect(tools[1].content).toContain("two");
  });

  it("functionResponse + co-located text keeps both", () => {
    const out = geminiToOpenAIRequest("gemini-2.0-flash", {
      contents: [{
        role: "user",
        parts: [
          { text: "here is the result" },
          { functionResponse: { id: "call_1", name: "bash", response: { result: "one" } } },
          { functionResponse: { id: "call_2", name: "read", response: { result: "two" } } },
        ],
      }],
    }, false);
    const tools = (out.messages || []).filter((m) => m.role === "tool");
    expect(tools.length).toBe(2);
    expect(JSON.stringify(out.messages)).toContain("here is the result");
  });
});
