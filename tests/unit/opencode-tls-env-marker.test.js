// P1-17d: upstream 0.5.111/0.5.112 OpenCode free-lane ports.
// - <env> marker: appended to the caller's own prompt, never replacing it,
//   in all three body shapes; never doubled when already present.
// - translateSessionId: one stable, valid session per conversation (memoized
//   on current time), NOT a fresh id per request — minting fresh sessions
//   burns the free quota window, and digest-derived timestamps are refused.
// - The TLS client file is upstream-verbatim (cipher list must stay exact);
//   the executor wrapper fails open to native fetch when wreq-js is absent.
// Run from tests/:
//   bun x vitest run unit/opencode-tls-env-marker.test.js
import { describe, it, expect } from "vitest";

const { applyEnvFingerprint, applyFingerprintTools } = await import("../../open-sse/utils/opencodeFingerprint.js");
const { translateSessionId } = await import("../../open-sse/executors/opencode.js");

describe("opencode <env> marker", () => {
  it("appends to an existing chat system message, preserving caller text", () => {
    const body = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content.startsWith("Be brief.")).toBe(true);
    expect(body.messages[0].content).toContain("<env>");
    expect(body.messages[0].content).toContain("Working directory:");
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends to a claude top-level system prompt, not to messages", () => {
    const body = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system.startsWith("Be brief.")).toBe(true);
    expect(body.system).toContain("<env>");
    expect(body.messages).toHaveLength(1);
  });

  it("appends to Responses instructions", () => {
    const body = { instructions: "Be brief." };
    expect(applyEnvFingerprint(body, true)).toBe(true);
    expect(body.instructions.startsWith("Be brief.")).toBe(true);
    expect(body.instructions).toContain("<env>");
  });

  it("never doubles a marker that is already present", () => {
    const body = { messages: [{ role: "system", content: "x\n<env>\n  Working directory: /tmp\n</env>" }] };
    expect(applyEnvFingerprint(body, false)).toBe(false);
    expect(body.messages[0].content).not.toContain("Here is some useful information");
  });

  it("is fail-open on surprising bodies", () => {
    expect(applyEnvFingerprint(null, false)).toBe(false);
    expect(applyEnvFingerprint({ messages: "not-an-array" }, false)).toBe(false);
    expect(applyEnvFingerprint({ instructions: 42 }, true)).toBe(false);
  });

  it("runs through applyFingerprintTools on every free-lane request shape", () => {
    const chat = { messages: [{ role: "user", content: "hi" }], tools: [] };
    applyFingerprintTools(chat, false);
    expect(chat.messages[0].content).toContain("<env>");
    const claude = { system: "Be brief.", messages: [{ role: "user", content: "hi" }], tools: [] };
    applyFingerprintTools(claude, false, { claude: true });
    expect(claude.system).toContain("<env>");
  });
});

describe("opencode translated sessions stay stable", () => {
  it("returns the same id for the same conversation, twice", () => {
    const first = translateSessionId("conv-123", "cli");
    const second = translateSessionId("conv-123", "cli");
    expect(first).toBe(second);
    expect(first).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]+$/);
  });

  it("passes a genuine CLI session id through untouched", () => {
    const cliId = translateSessionId("conv-9", "cli");
    expect(translateSessionId(cliId, "cli")).toBe(cliId);
  });

  it("keeps different conversations on different sessions", () => {
    expect(translateSessionId("conv-A", "cli")).not.toBe(translateSessionId("conv-B", "cli"));
  });
});
