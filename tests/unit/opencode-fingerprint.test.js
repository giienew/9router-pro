import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

describe("opencodeFingerprint — request side", () => {
  it("appends exact read/shell definitions and leaves case variants untouched", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual([...CC_TOOLS, ...OPENCODE_FINGERPRINT_TOOLS]);
    expect(map.size).toBe(0);
    const shell = body.tools.find((tool) => tool.name === "shell");
    expect(shell.description).toMatch(/^Execute a shell command/);
    expect(shell.parameters.required).toEqual(["command"]);
    expect(shell.strict).toBe(false);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["Edit", "read", "shell"]);
    const read = body.tools.find((tool) => tool.function?.name === "read");
    expect(read.function.parameters.required).toEqual(["path"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const body = { tools: flat(["read", "read_client", "Edit"]) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client2", "read_client", "Edit", "read", "shell"]);
    expect(map.get("read_client2")).toBe("read");
  });

  it("keeps a caller tool that already carries OpenCode's exact definition", () => {
    const first = { tools: [] };
    applyFingerprintTools(first, true);
    const official = first.tools.map((tool) => ({ ...tool }));

    const body = { tools: official };
    const map = applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(map.size).toBe(0);
    expect(body.instructions).toBeUndefined();
  });

  it("drops duplicate declarations of one fingerprint name", () => {
    const body = { tools: flat(["shell", "shell"]) };
    applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
  });

  it("defaults Responses tool_choice to auto and never to none for chat", () => {
    const responses = { tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.tool_choice).toBe("auto");

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(namesOf(chatBody.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(chatBody.tool_choice).toBeUndefined();
  });

  it("never injects a placeholder note into the prompt", () => {
    // The old "Do not call the ... tools" note is flagged by upstream OpenCode
    // content filtering as a third-party relay (429 FreeUsageLimitError), so
    // the prompt must stay exactly as the caller sent it.
    const responses = { instructions: "Be brief.", tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.instructions).toBe("Be brief.");
    expect(namesOf(responses.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);

    const chatBody = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(chatBody.messages).toHaveLength(2);
    expect(chatBody.messages[0].content).toBe("Be brief.");

    const noSystem = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(noSystem, false);
    expect(noSystem.messages).toEqual([{ role: "user", content: "hi" }]);

    const claudeShape = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(claudeShape, false);
    expect(claudeShape.messages).toHaveLength(1);
  });

  it("retargets flat tool_choice that points at an aliased tool", () => {
    const body = { tools: flat(["shell"]), tool_choice: { type: "function", name: "shell" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("shell_client");
  });

  it("retargets nested tool_choice that points at an aliased tool", () => {
    const body = {
      tools: chat(["read"]),
      tool_choice: { type: "function", function: { name: "read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(["read"]) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches exact fingerprint names only", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" shell ")).toBe("shell");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});

describe("opencodeFingerprint — in-place normalization", () => {
  // OpenCode builds shell's description from process.platform, so the very same
  // tool on Windows or macOS never matches the captured Linux definition.
  const shellTool = (os, shell, name = "shell") => ({
    type: "function",
    name,
    description:
      "Execute a shell command and return its output. Commands run on " + os + " using " + shell + ". Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  });

  const asChat = (tool) => ({
    type: tool.type,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  });
  const windowsShell = () => shellTool("Windows", "pwsh");

  it("keeps the caller's name and adopts OpenCode's definition when arguments line up", () => {
    const body = { tools: [windowsShell(), { type: "function", name: "Edit" }] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "Edit", "read"]);
    expect(map.size).toBe(0);
    expect(takeRenamedToolNames(body)).toBeNull();
    expect(body.tools[0].description).toContain("Commands run on Linux using bash.");
    expect(body.tools[0].parameters.required).toEqual(["command"]);
    // The appended `read` arrives without any placeholder note: prompts stay pristine.
    expect(body.instructions).toBeUndefined();
  });

  it("normalizes the nested chat shape without adding a system note", () => {
    const body = { tools: [asChat(windowsShell())] };
    const map = applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    expect(map.size).toBe(0);
    expect(body.messages).toBeUndefined();
    expect(body.tools[0].function.description).toContain("Commands run on Linux using bash.");
  });

  it("wires a real OpenCode client down to exactly read + shell", () => {
    const seeded = { tools: [] };
    applyFingerprintTools(seeded, false);
    const officialRead = seeded.tools.find((tool) => tool.function?.name === "read");

    const body = { tools: [officialRead, asChat(windowsShell())] };
    const map = applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["read", "shell"]);
    expect(map.size).toBe(0);
    expect(body.messages).toBeUndefined();
  });

  it("no longer invents alias names that a client plugin may already own", () => {
    const pluginTool = (name) => ({
      type: "function",
      name,
      description: "Execute a shell command and return its output.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    });
    const body = { tools: [pluginTool("shell_client"), pluginTool("shell_client2"), windowsShell()] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell_client", "shell_client2", "shell", "read"]);
    expect(map.size).toBe(0);
  });

  it("still conceals a fingerprint name whose arguments do not line up", () => {
    const body = {
      tools: [{
        type: "function",
        name: "shell",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
    expect(map.get("shell_client")).toBe("shell");
    expect(body.instructions).toBeUndefined();
  });

  it("conceals when the caller declares an argument the fingerprint does not", () => {
    const body = {
      tools: [{
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } }, required: ["path"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client", "read", "shell"]);
    expect(map.get("read_client")).toBe("read");
  });

  it("conceals when the caller is missing a required fingerprint argument", () => {
    const body = {
      tools: [{
        type: "function",
        name: "shell",
        description: "Run a command in a directory",
        parameters: { type: "object", properties: { workdir: { type: "string" } }, required: ["workdir"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
    expect(map.get("shell_client")).toBe("shell");
  });
});
