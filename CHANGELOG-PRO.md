# 9Router Pro — Changelog

Pro releases are tagged `v<upstream>-pro.<n>` (e.g. `v0.5.104-pro.2`) and
published as GitHub releases in this repo. The dashboard's update checker
follows these releases.

## v0.5.104-pro.3

- **Backup/restore hardened**: Settings backups now include Prompt Injections, per-key token quotas, and disabled models (previously skipped silently — a restore on a fresh install lost them). Every import first takes an automatic safety snapshot of the current database (kept in the data folder's `db/backups`, newest 3), and importing an older backup file no longer wipes Pro data the file knows nothing about. Backup files now carry a format + version marker.
- **Prompt Injection polish**: Browse-models picker in the Injection Tester (no more typing model names from memory); starter preset chips and the page byline removed — the editor opens clean, write your own prompt.
- **README**: real Pro screenshots (Prompt Injection, chat script editor, Providers) from a clean install.
- **Repo hygiene**: upstream's auto-publishing workflows (Docker image, GitBook docs) removed; install instructions point at this repo (`npm install -g github:giienew/9router-pro`).

## v0.5.104-pro.2

- **Per-key token quotas**: give any API key a token budget per 24h / 7d / 30d (Endpoint page → key → Token quota), with live usage + progress. Upstream removed this feature — Pro brings it back, KV-backed and fail-open.
- **Accent themes**: six dashboard accents (violet, azure, emerald, rose, amber, cyan) next to the original coral — one click in the header, saved per browser, applied before first paint. Fresh installs open in **violet**, the Pro signature.
- **Prompt Injection**: dead simple — one injection per target (global, per API key, per model), stacked global → user → model. Each injection is a single system prompt (prepend or append) or a **chat script** — user/bot turns inserted as fake history. Resolution is snapshot-cached and system prompts run as a single grouped pass per position, through the router's own wire-aware injector (OpenAI, Claude, Gemini, Responses). Idempotent and fail-open. The dashboard page (skull icon) includes an A/B tester (injected vs bare) with refusal-phrase verdicts.
- **Update notifications rewired** to this repo's GitHub releases (was: upstream npm package).

## v0.5.104-pro.1

First Pro release, based on 9Router v0.5.104 by decolua.

- **System-prompt injection engine**: custom system prompts injected after format translation through the router's own wire-aware injector — the foundation Prompt Injection (pro.2) is built on.
- Branding: 9Router Pro by Gienetic.
