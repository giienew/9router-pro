// [DONE] must be its own SSE event: strict OpenAI clients abort when the
// sentinel rides on the previous data line (no blank line in between), and a
// duplicate [DONE] confuses clients that count terminal events.
//
// Regression: the passthrough stream forwarded upstream framing verbatim, so
// an upstream that glued `data: [DONE]` onto the previous chunk
// (`data: {...}\ndata: [DONE]`) reached the client glued, and flush()
// appended a second `data: [DONE]` because streamDoneSent was never set on
// the passthrough path.
import { describe, it, expect } from "vitest";

import { createSSEStream } from "../../open-sse/utils/stream.js";

const chunk = (delta, extra = {}) => ({
  id: "chatcmpl-abc12345",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function runPassthrough(input) {
  const stream = createSSEStream({ mode: "passthrough", provider: "opencode-go" });
  const writer = stream.writable.getWriter();
  const readPromise = readAll(stream.readable);
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  return readPromise;
}

// Split the raw SSE bytes into events the way a strict client sees them:
// an event ends at a blank line; every event must be a single `data:` line.
function sseEvents(text) {
  return text.split("\n\n").map((e) => e.trim()).filter(Boolean);
}

describe("passthrough [DONE] framing", () => {
  it("un-glues a [DONE] that arrives on the previous data line", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}\ndata: [DONE]\n\n`;
    const out = await runPassthrough(input);

    const events = sseEvents(out);
    expect(events).toHaveLength(2);
    expect(events[0]).toBe(`data: ${JSON.stringify(chunk({ content: "hi" }))}`);
    expect(events[1]).toBe("data: [DONE]");
  });

  it("keeps a properly framed [DONE] as its own event without doubling it", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}\n\ndata: [DONE]\n\n`;
    const out = await runPassthrough(input);

    const events = sseEvents(out);
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("data: [DONE]");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("terminates a stream that ends after a data line with no blank line", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}\n`;
    const out = await runPassthrough(input);

    const events = sseEvents(out);
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("data: [DONE]");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("terminates a stream that ends after a blank line", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}\n\n`;
    const out = await runPassthrough(input);

    const events = sseEvents(out);
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("data: [DONE]");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("terminates a leftover data line in flush before the terminal [DONE]", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}`;
    const out = await runPassthrough(input);

    const events = sseEvents(out);
    expect(events).toHaveLength(2);
    expect(events[0]).toBe(`data: ${JSON.stringify(chunk({ content: "hi" }))}`);
    expect(events[1]).toBe("data: [DONE]");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("does not duplicate a leftover [DONE] in flush", async () => {
    const input = `data: ${JSON.stringify(chunk({ content: "hi" }))}\n\ndata: [DONE]`;
    const out = await runPassthrough(input);

    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
    const events = sseEvents(out);
    expect(events[events.length - 1]).toBe("data: [DONE]");
  });
});
