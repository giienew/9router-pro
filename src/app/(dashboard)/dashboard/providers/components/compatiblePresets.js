// Quick-add presets for custom OpenAI-compatible providers (9Router Pro).
// Every preset is an ordinary OpenAI-compatible endpoint — the preset
// only pre-fills the Add modal's name, prefix and base URL; the user
// reviews and saves like any other custom provider.
export const COMPATIBLE_PRESETS = [
  { key: "openrouter", name: "OpenRouter", prefix: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { key: "deepseek", name: "DeepSeek", prefix: "deepseek", baseUrl: "https://api.deepseek.com/v1" },
  { key: "xai", name: "xAI Grok", prefix: "xai", baseUrl: "https://api.x.ai/v1" },
  { key: "mistral", name: "Mistral", prefix: "mistral", baseUrl: "https://api.mistral.ai/v1" },
  { key: "groq", name: "Groq", prefix: "groq", baseUrl: "https://api.groq.com/openai/v1" },
  { key: "together", name: "Together", prefix: "together", baseUrl: "https://api.together.xyz/v1" },
  { key: "fireworks", name: "Fireworks", prefix: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { key: "cerebras", name: "Cerebras", prefix: "cerebras", baseUrl: "https://api.cerebras.ai/v1" },
  { key: "gemini", name: "Gemini (OpenAI mode)", prefix: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  { key: "ollama", name: "Ollama (local)", prefix: "ollama", baseUrl: "http://localhost:11434/v1" },
  { key: "lmstudio", name: "LM Studio (local)", prefix: "lmstudio", baseUrl: "http://localhost:1234/v1" },
];
