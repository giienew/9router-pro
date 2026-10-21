# 9Router Pro — Changelog

Pro releases are tagged `v<upstream>-pro.<n>` (e.g. `v0.5.104-pro.2`) and
published as GitHub releases in this repo. The dashboard's update checker
follows these releases.

## v0.5.104-pro.4.1

- **Mobile sidebar scroll fix**: on phones the navigation drawer grew with its content instead of filling the viewport, so menu entries below the fold (Media Providers children and everything under them) could not be reached — the nav's scroll area never engaged. The sidebar is now viewport-bounded (`h-full` + `max-h-dvh`, `min-h-0` on the nav region, `h-dvh` on the mobile drawer wrapper) and scrolls properly on mobile and desktop.

## v0.5.104-pro.4

- **Anti-Flaky Guard**: some upstreams answer HTTP 200 with an empty body or a degenerate repetition loop ("OK.OK.OK..."). The guard inspects each finished response (OpenAI / Claude / Responses / Gemini shapes — the body is probed directly, since some executor paths mislabel a JSON body as text/event-stream, and even malformed JSON is salvaged and judged by its content), and on a flaky verdict retries on another account of the same model instead of passing garbage to the client. Tool calls and reasoning-only answers are never flagged. Fail-open throughout: retries are capped (Settings → Token Saver page, default 2), the account is not marked unavailable, the last flaky response is rescued if the pool runs out, and recovered responses carry an `x-9router-pro-flaky-retries` header. Long live streams are released uninspected.
- **Key Health Manager**: new dashboard page for pool hygiene at scale. Every connection of a provider is classified live — active / cooldown / unavailable / error / unknown / disabled — from the state the request path already maintains. Batch-test a page, a selection, or single keys (bounded chunks, same probe as the Providers page, status written back in place), delete selected keys, or delete all dead keys of a provider in one transactional sweep (single priority reorder, safe on five-figure pools).
- **Backup completeness**: Settings backups now also carry Brief Mode settings and Token Saver savings stats (the last two Pro scopes that were still skipped); imports of older files still never wipe them.
- **Modder socials**: GitHub and Telegram icons next to the "Modder by Gienetic" credit in the sidebar and on the login page, linking to the modder's accounts.

## v0.5.104-pro.3

- **Token Saver Pro**: three additions on the Token Saver page. **Savings panel** — RTK compression stats are now persisted (they were console-log only): estimated tokens saved, requests compressed, 14-day chart, top filters. **Brief Mode** — Caveman terseness scoped global / per API key / per model (model beats key beats global), overriding the global Caveman setting per request. **Test Bench** — paste any tool output and run the real RTK pipeline to preview savings before it ever hits a request.
- **Dashboard performance**: no page fetches the full provider-connection list anymore — the remaining consumers (CLI tools, media providers, MITM, usage stats, Xiaomi auth) use the slim `?lite=1` projection, and the media connections card uses the server-side `?provider=` filter.
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
