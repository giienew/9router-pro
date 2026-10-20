# 9Router Pro — Changelog

Pro releases are tagged `v<upstream>-pro.<n>` (e.g. `v0.5.104-pro.2`) and
published as GitHub releases in this repo. The dashboard's update checker
follows these releases.

## v0.5.104-pro.2

- **Per-key token quotas**: give any API key a token budget per 24h / 7d / 30d (Endpoint page → key → Token quota), with live usage + progress. Upstream removed this feature — Pro brings it back, KV-backed and fail-open.
- **Accent themes**: six dashboard accents (violet, azure, emerald, rose, amber, cyan) next to the original coral — one click in the header, saved per browser, applied before first paint. Fresh installs open in **violet**, the Pro signature.
- **Prompt Inject import/export**: back up and share profile packs as JSON.
- **Free AI page**: one-click setup for free OpenAI-compatible services — Pollinations (fully keyless), LLM7.io (key optional), Groq, OpenRouter free models, Cerebras.
- **Update notifications rewired** to this repo's GitHub releases (was: upstream npm package).

## v0.5.104-pro.1

First Pro release, based on 9Router v0.5.104 by decolua.

- **Prompt Inject engine**: reusable system-prompt profiles bound globally, per API key, or per model (combo / alias / provider-model), each prepend or append, injected after format translation through the router's own wire-aware injector (OpenAI, Claude, Gemini, Responses, Kiro). Idempotent and fail-open.
- **Prompt Inject dashboard page**: profile CRUD, starter presets, auto-saving bindings, per-model name suggestions.
- Branding: 9Router Pro by Gienetic.
