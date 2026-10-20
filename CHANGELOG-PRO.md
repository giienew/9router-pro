# 9Router Pro — Changelog

Pro releases are tagged `v<upstream>-pro.<n>` (e.g. `v0.5.104-pro.2`) and
published as GitHub releases in this repo. The dashboard's update checker
follows these releases.

## v0.5.104-pro.2

- **Per-key token quotas**: give any API key a token budget per 24h / 7d / 30d (Endpoint page → key → Token quota), with live usage + progress. Upstream removed this feature — Pro brings it back, KV-backed and fail-open.
- **Accent themes**: six dashboard accents (violet, azure, emerald, rose, amber, cyan) next to the original coral — one click in the header, saved per browser, applied before first paint. Fresh installs open in **violet**, the Pro signature.
- **Soul Prompts**: system prompts redesigned to be dead simple — one prompt per target (a Global Soul for the whole router, a User Soul per API key, a Model Soul per model), each prepend or append, stacked global → user → model. Resolution is snapshot-cached and injection runs as a single pass per position, through the router's own wire-aware injector (OpenAI, Claude, Gemini, Responses, Kiro). Idempotent and fail-open.
- **Update notifications rewired** to this repo's GitHub releases (was: upstream npm package).

## v0.5.104-pro.1

First Pro release, based on 9Router v0.5.104 by decolua.

- **System-prompt injection engine**: custom system prompts injected after format translation through the router's own wire-aware injector — the foundation Soul Prompts (pro.2) is built on.
- Branding: 9Router Pro by Gienetic.
