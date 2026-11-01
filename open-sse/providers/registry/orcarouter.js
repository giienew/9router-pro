export default {
  id: "orcarouter",
  alias: "orcarouter",
  aliases: ["orca"],
  uiAlias: "orcarouter",
  display: {
    name: "OrcaRouter",
    icon: "hub",
    color: "#0EA5E9",
    textIcon: "OR",
    website: "https://orcarouter.ai",
    notice: {
      text: "OpenAI-compatible gateway. 40+ providers (OpenAI, Claude, Gemini, DeepSeek, Grok, Qwen, Kimi, GLM...). Rate limits are per workspace — account rotation only helps keys from different workspaces.",
      apiKeyUrl: "https://orcarouter.ai",
    },
  },
  category: "apikey",
  // Small example set only — the full catalogue (191 models) is fetched live via
  // modelsFetcher and offered in "Suggested free models"; any provider-prefixed id
  // is accepted via passthroughModels. Keep this list short so it stays a hint,
  // not a hardcoded catalog.
  models: [
    { id: "openai/gpt-5", name: "GPT 5" },
    { id: "openai/gpt-4o-mini", name: "GPT 4O Mini" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
  ],
  transport: {
    baseUrl: "https://api.orcarouter.ai/v1/chat/completions",
    validateUrl: "https://api.orcarouter.ai/v1/models",
  },
  modelsFetcher: { url: "https://api.orcarouter.ai/v1/models", type: "openai" },
  passthroughModels: true,
  features: { usage: true, usageApikey: true },
  serviceKinds: ["llm"],
};