// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  // #2132's concern — Responses tool/reasoning history must never be
  // collapsed into a message and round-tripped through the proxy — is
  // answered by the native tool-output path, not by skipping: only the
  // plain-text function_call_output leaves are sent, and the protocol
  // items (function_call arguments, reasoning summary, tool schemas)
  // stay byte-identical in the body. The earlier skip-everything
  // reading of #2132 contradicted that path (it broke 8
  // headroom-tool-outputs tests), so this test asserts the leaf-only
  // behavior instead of a blanket skip.
  it("does not collapse Responses tool/reasoning history into a message (#2132): only plain-text output leaves reach the proxy", async () => {
    global.fetch = vi.fn(async (_url, init) => ({
      ok: true,
      json: async () => ({
        messages: JSON.parse(init.body).messages.map((m) => ({ ...m, content: "short result" })),
        tokens_saved: 10,
      }),
    }));

    const longOutput = "Patch applied successfully. All 12 files updated, 3 tests passing.\n".repeat(20);
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: longOutput,
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const expected = structuredClone(body);
    expected.input[2].output = "short result";

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(body).toEqual(expected);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ role: "tool", content: longOutput });
    expect(JSON.stringify(sent)).not.toContain("Need a plan");
    expect(JSON.stringify(sent)).not.toContain("Begin Patch");
  });
});
