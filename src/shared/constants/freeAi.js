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
    limits: "Anonymous seed bucket is small and IP-based; a free key from enter.pollinations.ai raises it",
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
    limits: "Anonymous tier works; free token ≈60 req/min + a daily token allowance",
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
    limits: "Free tier per model ≈30 req/min, 1,000 req/day (org-level)",
    modelsHint: "openai/gpt-oss-120b, qwen3, whisper-large-v3…",
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
    id: "aistudio",
    name: "Google AI Studio",
    kind: "node",
    prefix: "aistudio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyMode: "free-key",
    badge: "Free key",
    blurb: "Gemini models through Google's OpenAI-compatible layer. Free API key from AI Studio, no billing required — huge context windows included.",
    limits: "Free tier with per-model caps (see your AI Studio rate-limit dashboard)",
    modelsHint: "gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-lite…",
    homeUrl: "https://aistudio.google.com",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    kind: "node",
    prefix: "nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyMode: "free-key",
    badge: "Free key",
    blurb: "The widest free catalog: 100+ hosted models — Nemotron, Llama, DeepSeek, Qwen, Kimi, GLM — with a free NVIDIA Developer account.",
    limits: "~40 req/min per model; free inference credits on signup (dev/eval use)",
    modelsHint: "deepseek-ai/deepseek-r1, meta/llama-3.3-70b-instruct, moonshotai/kimi…",
    homeUrl: "https://build.nvidia.com",
    keyUrl: "https://build.nvidia.com",
  },
];
