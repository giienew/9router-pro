# Rival-track features (impl/rival) — operator notes

Original implementations of the rival feature ideas from growth audit #2
(§E.2, R1–R15). No rival code was copied; everything reuses Pro's own
APIs, components and tokens, in the flat dark theme.

## R1 — Free stack (Combos page, advisor sections)

- `GET /api/combos/advisor?mode=free&probe=1` builds a ranked free combo
  from the user's own active connections + registry seeds (never shared
  pools, never direct SQLite writes). Rate-limited models go to a
  `free-stack-holding` cooldown combo, never the live stack.
- Dry-run is the default: `POST /api/combos/advisor` without `apply:true`
  returns the preview only. Apply creates the combo (and the holding combo
  with `applyHolding:true`).
- Watchdog: `src/lib/freeStackWatchdog.js`, boot-armed from
  `initializeApp` in the auto-backup scheduler pattern (timer chain,
  unref'd). It re-probes and stores a fresh draft + trust event; it never
  applies. Enabled only when `settings.freeStackWatchdogEnabled` is true
  or `FREE_STACK_WATCHDOG=on` (interval: `FREE_STACK_INTERVAL_MS`,
  default hourly).

## R2 — Trust inbox

- `src/lib/trustEvents.js` + `trustEvents` table (additive schema change).
  Bell: `src/shared/components/TrustInboxBell.js` in the Header, polling
  `/api/notifications` every 30s. Quota pressure warns at 90% and goes
  critical at the cap (wired into `/api/keys` GET, deduped; clearing
  re-arms so a recurrence shows unread again). Failed-request events come
  from `/v1/chat/completions` on 5xx. Security events come from the
  security log. Toasts are untouched.

## R3 — Security log

- `securityLog` table (additive). Login/logout/TOTP events (timestamp,
  IP, user agent) are written from the auth routes, fire-and-forget.
  5+ failed logins from one IP in an hour set a breach flag and post a
  critical trust event. `GET /api/security-log` requires a valid dashboard
  session cookie. A section is appended to the Profile page (append-only;
  the page's split shape is owner-reserved and was not restructured).

## R4 — Combo advisor (Combos page, advisor sections)

- `GET /api/combos/advisor?mode=tiered`: probes active connections for
  health/latency (stored testStatus + `/api/usage/latency` p50, or a
  bounded live probe of ≤3 providers via the existing test path),
  dedupes the same model across duplicate accounts, filters to chat
  models, and proposes one quality / one fast / one free member as a
  DRAFT. One-click Apply creates it; serving-time auto-routing (P3-25)
  is separate and untouched.

## R5 — Gateway MCP server

- `POST /api/mcp/gateway` (JSON-RPC over HTTP) + `GET` info. Read-only
  tools: `list_providers` (redacted, no credentials), `list_combos`,
  `health_summary`, `auto_routing_intents`. Auth: a valid Pro API key
  (Bearer) or dashboard session cookie. Every tool call is audit-trailed
  to the security log. The existing plugin routes
  (`/api/mcp/[plugin]/...`) are untouched.
- PENDING — mutating tools: not shipped. They need an explicit dashboard
  approval flow (approval queue UI) that does not exist yet; `tools/call`
  for an unknown/mutating tool returns an error saying so.

## R6 — At-rest encryption

- `src/lib/atRestCrypto.js`: AES-256-GCM over connection `data` sensitive
  fields (apiKey, access/refresh/id tokens, secrets), in
  `connectionsRepo`'s single write/read points (`connToRow`/`rowToConn`).
  Key: env `PRO_CREDENTIAL_KEY` (64 hex chars or base64 of 32 bytes).
  Never logged, never committed. Without a key, writes stay plaintext
  and reads fall back to plaintext — existing connections never break.
- `GET /api/settings/encryption` reports key status + plaintext vs
  encrypted counts (never values). `POST` with the dashboard password
  runs a dry-run count or the explicit migration, which re-writes legacy
  rows through encrypt-on-write. Migration is reversible (decrypt with
  the same key). If the key is never set, legacy plaintext remains —
  that is the documented pending state, not a silent failure.

## R7 — Locked sampling per variant

- Variant records gain optional `temperature` / `top_p` / `max_tokens`
  (`cleanSamplingParams` in `promptInjectRepo`, ranges validated, prompt
  text untouched). The variant editor (PromptInjectionClient) has fields
  for them. At dispatch (`sse/handlers/chat.js`), a direct variant pick
  or a combo member naming a variant overrides the client's defaults for
  that request only (`applyVariantSampling`).

## R8 — Usage proof (inside Usage, no new page)

- Overview cards gained sparklines (`OverviewCards` + `series` from
  `/api/usage/chart`, wired in `UsageStats`).
- `usage/components/UsageProof.js`: a 30-day activity heatmap from the
  existing chart buckets, and a savings view reading the same
  `/api/token-saver/stats` source the Token Saver page uses, with a link
  to it (not a second savings page).

## R9 — Auto-routing refinements (P3-25, not a rebuild)

- Measured latency: `buildAutoCandidates` accepts `latencyByProvider`
  (p50 from `/api/usage/latency`); `fast` scores on it instead of the
  small-context proxy when available, other intents get a small bonus.
  The serving path loads it via a 60s-cached helper
  (`getLatencyByProviderCached`).
- Exploration: 5% (`AUTO_EXPLORATION_SHARE`), deterministic per
  intent+day, promoting one lower-ranked candidate to the front. It is
  OFF by default in `buildAutoCandidates` (so existing tests stay
  deterministic) and enabled only on the serving path. Health tiers and
  sticky behaviour are untouched.
- PENDING — reset-awareness: no per-provider reset-window data exists in
  routing inputs (quota `resetAt` lives only on the ProviderLimits UI
  from live quota endpoints; antigravity's is fetched live on 409/429).
  It stays pending until such data is stored per provider.

## R10 — Catalog search modal (also P3-30 "live catalog import")

- `GET /api/providers/catalog-search` aggregates the existing
  per-provider suggested-models feeds (same FILTERS normalization, no
  feed duplication) plus registry seeds only for providers with no feed.
  Filters: name, min context, max price (where the feed carries pricing),
  vision, reasoning. Import reuses `POST /api/models/custom`.
- UI: `providers/components/CatalogSearchModal.js`, opened from the
  Providers page toolbar ("Search catalogs").

## R11 — Bulk key edit

- `PATCH /api/keys` (GET/POST and single-key PUT untouched): per-key
  results, one bad key never aborts the rest. `quota:null` /
  `limits:null` clear, mirroring single-key PUT.
- Endpoint page: checkboxes + select-all + "Bulk edit" modal (expiry,
  token quota, TPM limit, model policy as comma-separated
  combos/models, pause/resume). Edits to `EndpointPageClient.js` are
  localized to the selection bar, the checkbox column and the modal.

## R12 — CLI doctor / setup / dry-run (also P3-30 "Pro CLI doctor/setup")

- `cli/src/cli/commands/doctor.js` (`9router doctor`): Node ≥22,
  package version, data/runtime dirs, `.env.local`, port, server health.
  Read-only, exit 1 on any FAIL. `setup.js` (`9router setup`): guided
  wizard, masked password prompt, exact `.env.local` preview (password
  masked) + confirmation before writing, refuses to overwrite without
  `--force`. `dryrun.js` (`9router dry-run --url … [tools]`): lists the
  files `connect` would write and the values (key masked), writes
  nothing. Wired in `cli/cli.js` next to `connect`/`show`; no other CLI
  surface changed.

## R13 — Semantic cache

- `src/lib/semanticCache.js` on top of the exact cache: Jaccard word
  similarity, default threshold 0.8, opt-in via
  `settings.responseCache.semantic.enabled` (fresh-install default off).
  Scoped per API key (sha256 of the key) + model — never across keys.
  Chat-path hook only, in `/v1/chat/completions` after the exact-cache
  miss (header `X-9Router-Cache: SEMANTIC` on hit).

## R14 — Eval runner

- `src/lib/evalRunner.js` (scoring: answer contains expected substring,
  case-insensitive; prompts without expectations excluded from pass
  rate), `evalSets`/`evalRuns` tables, `/api/evals` (create / run /
  delete / list). Runs go through the router's own chat endpoint with a
  caller-supplied API key that is never stored.
- UI: `/dashboard/evals` (nav entry added) — saved sets + a per-model
  pass-rate results table. Explicitly NOT a side-by-side chat page: no
  comparison columns, no live chat columns. Testing Studio was not
  rebuilt.

## R15 — Packaging

- PWA: `public/manifest.json` (static mirror of the existing
  `src/app/manifest.js`, same icon assets, no new artwork) plus
  `categories`/`id` on the generated manifest. Theme color already
  `#0a0a0a`.
- Termux: `scripts/termux-install.sh` (Node + git, clone, install,
  `setup` → `npm start` → `doctor`).
- Electron: `packaging/electron/main.js` is a thin wrapper that spawns
  the existing `custom-server.js` start path and opens the dashboard.
  PENDING — native build pipeline (electron-builder config, signing,
  auto-update, `electron.main` wiring) is out of scope for this run;
  the wrapper is deliberately not wired into `package.json` so npm/PM2/
  Docker installs are unaffected.

## Owner-reserved fates (not decided here)

- Landing fate, pricing fate, shadow routes (basic-chat/mitm/pxpipe)
  fate, imageToText visibility: untouched. The evals page is a new
  dashboard page for a new feature, not a fate decision on any shadow
  route; no shadow route was linked, moved or removed.

## Version

- `0.5.109-pro.15` everywhere; no version field was bumped.
