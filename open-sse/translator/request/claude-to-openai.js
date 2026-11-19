import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { collapseTextParts } from "../concerns/message.js";

function stripAnthropicBillingHeader(text) {
  if (typeof text !== "string") return "";
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");
}

// Convert Claude request to OpenAI format
export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens
  if (body.max_tokens) {
    result.max_tokens = adjustMaxTokens(body);
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // System message. A cache_control marker on a system block is carried
  // through as array content: a plain string cannot hold one, and the
  // downstream filterToOpenAIFormat keeps the array (with the marker) only
  // for providers whose preserveCacheControl quirk opts in — every other
  // provider gets the marker stripped and the parts collapsed back to a
  // string, exactly as before.
  if (body.system) {
    const systemBlocks = Array.isArray(body.system) ? body.system : null;
    const hasSystemCache = systemBlocks?.some((s) => s?.cache_control);
    if (hasSystemCache) {
      const parts = systemBlocks
        .map((s) => {
          const text = stripAnthropicBillingHeader(s.text || "");
          if (!text) return null;
          return {
            type: OPENAI_BLOCK.TEXT,
            text,
            ...(s.cache_control ? { cache_control: { ...s.cache_control } } : {}),
          };
        })
        .filter(Boolean);
      if (parts.length) {
        result.messages.push({ role: ROLE.SYSTEM, content: parts });
      }
    } else {
      const systemContent = Array.isArray(body.system)
        ? body.system.map(s => stripAnthropicBillingHeader(s.text || "")).filter(Boolean).join("\n")
        : stripAnthropicBillingHeader(body.system);

      if (systemContent) {
        result.messages.push({
          role: ROLE.SYSTEM,
          content: systemContent
        });
      }
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const converted = convertClaudeMessage(msg);
      if (converted) {
        // Handle array of messages (multiple tool results)
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses - OpenAI requires every tool_call to have a response.
  // Local variant: scans contiguous tool replies + inserts "[No response received]"
  // (distinct from the global immediate-next check in concerns/toolCall, runs on the openai leg).
  fixMissingToolResponsesOpenAI(result.messages);

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => ({
      type: OPENAI_BLOCK.FUNCTION,
      function: {
        name: tool.name,
        description: String(tool.description || ""),
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  if (body.reasoning_effort !== undefined) {
    result.reasoning_effort = body.reasoning_effort;
  } else if (body.reasoning?.effort !== undefined) {
    result.reasoning_effort = body.reasoning.effort;
  }

  if (body.reasoning !== undefined) {
    result.reasoning = body.reasoning;
  }

  return result;
}

// Fix missing tool responses - add empty responses for tool_calls without responses
function fixMissingToolResponsesOpenAI(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      
      // Collect all tool response IDs that IMMEDIATELY follow this assistant message
      const respondedIds = new Set();
      let insertPosition = i + 1;
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === ROLE.TOOL && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      // Find missing responses and insert them
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: ROLE.TOOL,
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// Wrap mid-conversation system text so it ends as a user turn (avoids Anthropic prefill 400).
// Uses <instructions> tags that Claude models treat as authoritative directives.
function systemReminderText(content) {
  const parts = Array.isArray(content)
    ? content.filter(c => c?.type === CLAUDE_BLOCK.TEXT).map(c => c.text || "")
    : [typeof content === "string" ? content : ""];
  const text = parts.filter(Boolean).join("\n");
  if (!text.trim()) return "";
  return `<instructions>\n${text}\n</instructions>`;
}

// Convert single Claude message - returns single message or array of messages
function convertClaudeMessage(msg) {
  // Some clients send content as a single block object; normalize to the
  // one-element array every branch below (the system-reminder fold included)
  // expects. Must run BEFORE the role branch: systemReminderText only reads
  // arrays and strings, so a bare-object system turn was dropped outright.
  if (msg.content && typeof msg.content === "object" && !Array.isArray(msg.content)) {
    msg.content = [msg.content];
  }
  // Mid-conversation system message -> user (per Anthropic placement rules)
  if (msg.role === ROLE.SYSTEM) {
    const text = systemReminderText(msg.content);
    return text ? { role: ROLE.USER, content: text } : null;
  }

  const role = msg.role === ROLE.USER || msg.role === ROLE.TOOL ? ROLE.USER : ROLE.ASSISTANT;
  
  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    let reasoningText = "";
    const redactedThinking = [];

    for (const block of msg.content) {
      switch (block.type) {
        case CLAUDE_BLOCK.TEXT:
          // Carry the client's cache_control through: the downstream
          // filterToOpenAIFormat preserves it only for providers that opt
          // in via preserveCacheControl (e.g. alicode/DashScope) and strips
          // it for everyone else. collapseTextParts keeps marked parts as
          // an array — a string could not hold the marker.
          parts.push({
            type: OPENAI_BLOCK.TEXT,
            text: block.text,
            ...(block.cache_control ? { cache_control: { ...block.cache_control } } : {}),
          });
          break;

        case CLAUDE_BLOCK.THINKING:
          // Caller-sent thinking (e.g. Claude Code history) used to fall
          // through silently, losing the reasoning on the bridge leg. Carry
          // the text as reasoning_content on the assistant message.
          if (typeof block.thinking === "string" && block.thinking) {
            reasoningText += (reasoningText ? "\n" : "") + block.thinking;
          }
          break;

        case CLAUDE_BLOCK.REDACTED_THINKING:
          // No plaintext form exists; keep the encrypted blob restorable in
          // provider_specific_fields instead of dropping it.
          if (block.data) {
            redactedThinking.push({ data: block.data });
          }
          break;

        case CLAUDE_BLOCK.IMAGE:
          if (block.source?.type === "base64") {
            parts.push({
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: {
                url: encodeDataUri(block.source.media_type, block.source.data)
              }
            });
          }
          break;

        case CLAUDE_BLOCK.TOOL_USE:
          toolCalls.push({
            id: block.id,
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
          break;

        case CLAUDE_BLOCK.TOOL_RESULT: {
          // NOTE: a cache_control on the tool_result block is deliberately
          // NOT carried here. The OpenAI tool role is text-only — there is
          // no content-block array to hold the marker — and the downstream
          // filter returns tool messages as-is, so attaching it to the tool
          // message would leak it to providers that do not support caching.
          let resultContent = "";
          const resultImages = [];
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c?.type === CLAUDE_BLOCK.IMAGE && c.source?.type === "base64") {
                resultImages.push({
                  type: OPENAI_BLOCK.IMAGE_URL,
                  image_url: { url: encodeDataUri(c.source.media_type, c.source.data) }
                });
              }
            }
            const textOnly = block.content.filter(c => c?.type === CLAUDE_BLOCK.TEXT);
            resultContent = textOnly.map(c => c.text).join("\n")
              || (resultImages.length ? "" : JSON.stringify(block.content));
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }

          toolResults.push({
            role: ROLE.TOOL,
            tool_call_id: block.tool_use_id,
            content: resultContent
          });
          // The OpenAI tool role is text-only, so a screenshot or any other image a
          // tool returned would otherwise vanish. Hand it to the model in the user
          // turn that follows the tool messages, tagged with the call it came from.
          if (resultImages.length) {
            parts.push({ type: OPENAI_BLOCK.TEXT, text: `[Image from tool result ${block.tool_use_id}]` });
            parts.push(...resultImages);
          }
          break;
        }
      }
    }

    // If has tool results, return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        return [...toolResults, { role: ROLE.USER, content: collapseTextParts(parts) }];
      }
      return toolResults;
    }

    // If has tool calls, return assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: ROLE.ASSISTANT };
      if (parts.length > 0) {
        result.content = collapseTextParts(parts);
      }
      if (reasoningText) {
        result.reasoning_content = reasoningText;
      }
      if (redactedThinking.length > 0) {
        result.provider_specific_fields = { redacted_thinking: redactedThinking };
      }
      result.tool_calls = toolCalls;
      return result;
    }

    // Return content
    if (parts.length > 0) {
      const result = {
        role,
        content: collapseTextParts(parts)
      };
      if (reasoningText) {
        result.reasoning_content = reasoningText;
      }
      if (redactedThinking.length > 0) {
        result.provider_specific_fields = { redacted_thinking: redactedThinking };
      }
      return result;
    }

    // Thinking-only message: the reasoning is the whole content — it must not
    // vanish into a null message.
    if (reasoningText || redactedThinking.length > 0) {
      const result = { role: ROLE.ASSISTANT };
      if (reasoningText) {
        result.reasoning_content = reasoningText;
      }
      if (redactedThinking.length > 0) {
        result.provider_specific_fields = { redacted_thinking: redactedThinking };
      }
      return result;
    }
    
    // Empty content array
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

// Convert tool choice
function convertToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  
  switch (choice.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "tool": return { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    default: return "auto";
  }
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, claudeToOpenAIRequest, null);
