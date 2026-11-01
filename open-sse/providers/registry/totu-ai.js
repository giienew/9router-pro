export default {
  id: "totu-ai",
  alias: "totu-ai",
  category: "apikey",
  display: {
    name: "TOTU AI",
    icon: "bolt",
    color: "#8B5CF6",
    textIcon: "TA",
    website: "https://totu-ai.com",
    notice: {
      text: "OpenAI-compatible NewAPI gateway. Models and credentials are managed through the TOTU AI dashboard; model catalogue is auto-fetched from the public pricing endpoint.",
      apiKeyUrl: "https://totu-ai.com",
    },
  },
  transport: {
    baseUrl: "https://totu-ai.com/v1/chat/completions",
    validateUrl: "https://totu-ai.com/v1/models",
  },
  // Small example set only — the full catalogue is fetched live via modelsFetcher
  // and offered in "Suggested free models"; any provider-prefixed id is accepted
  // via passthroughModels. Keep this list short so it stays a hint, not a
  // hardcoded catalog.
  models: [
    { id: "openai/gpt-5", name: "Gpt 5" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  ],
  features: { usage: true, usageApikey: true },
  serviceKinds: ["llm", "embedding", "image"],
  embeddingConfig: {
    baseUrl: "https://totu-ai.com/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
  imageConfig: {
    baseUrl: "https://totu-ai.com/v1/images/generations",
  },
  modelsFetcher: { url: "https://totu-ai.com/api/pricing", type: "pricing" },
  passthroughModels: true,
};
