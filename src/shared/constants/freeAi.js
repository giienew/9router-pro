// 9Router Pro — Free AI catalog: genuinely free OpenAI-compatible services
// the dashboard can wire up in one click.
//
// kind "node":  a custom OpenAI-compatible node is created first
//               (POST /api/provider-nodes), then a connection on it.
// kind "builtin": the provider already exists upstream; only a connection
//               is created (POST /api/providers).
// keyMode "none":     no key at all — a placeholder key is stored.
// keyMode "optional": works keyless (rate-limited); a free token raises limits.
// keyMode "free-key": a free account key is required (user pastes their own).

export const FREE_AI_SERVICES = [
  {
    id: "pollinations",
    name: "Pollinations",
    kind: "node",
    prefix: "pollinations",
    baseUrl: "https://gen.pollinations.ai/v1",
    keyMode: "none",
    placeholderKey: "no-key-required",
    badge: "No key · No signup",
    blurb: "Completely keyless AI gateway. Anonymous tier runs on a small seed allowance — chat, reasoning, and vision models included.",
    limits: "Anonymous tier; ~3s between requests on the free seed bucket",
    modelsHint: "openai (GPT-5.4 Nano), openai-reasoning, mistral, deepseek, kimi…",
    homeUrl: "https://pollinations.ai",
  },
  {
    id: "llm7",
    name: "LLM7.io",
    kind: "builtin",
    provider: "llm7",
    keyMode: "optional",
    placeholderKey: "no-key-required",
    badge: "Key optional",
    blurb: "Free OpenAI-compatible endpoint. Works with no token at all; a free token from llm7.io raises the rate limit.",
    limits: "Anonymous ~10 req/min · free token ~100 req/min",
    modelsHint: "DeepSeek, GPT-OSS, Llama, Qwen and more (auto-discovered)",
    homeUrl: "https://llm7.io",
    keyUrl: "https://llm7.io",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "builtin",
    provider: "groq",
    keyMode: "free-key",
    badge: "Free key",
    blurb: "Blazing-fast LPU inference with a generous free tier — Llama, Qwen, GPT-OSS at hundreds of tokens per second.",
    limits: "Free tier rate limits per model (e.g. 30 req/min on popular models)",
    modelsHint: "llama-3.3-70b, qwen3, openai/gpt-oss-120b…",
    homeUrl: "https://groq.com",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter (free models)",
    kind: "builtin",
    provider: "openrouter",
    keyMode: "free-key",
    badge: "Free key",
    blurb: "One key, many free models — look for model ids ending in :free. Great as an always-on fallback.",
    limits: "Free models: 20 req/min, daily cap (higher with a $10 lifetime top-up)",
    modelsHint: "deepseek-chat-v3:free, llama-3.3-70b:free, qwen:free…",
    homeUrl: "https://openrouter.ai",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "builtin",
    provider: "cerebras",
    keyMode: "free-key",
    badge: "Free key",
    blurb: "Wafer-scale inference — extremely fast GPT-OSS and Llama with a free API tier, no card required.",
    limits: "Free tier: ~30 req/min, generous daily token allowance",
    modelsHint: "gpt-oss-120b, llama-3.3-70b…",
    homeUrl: "https://www.cerebras.ai",
    keyUrl: "https://cloud.cerebras.ai",
  },
];
