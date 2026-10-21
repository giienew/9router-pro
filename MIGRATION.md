# Migrating from 9Router (original) to 9Router Pro

9Router Pro is a **standalone edition** built on the same 9Router v0.5.104
codebase — it is not a plugin, and it does not connect to or control your
existing 9Router install. You run Pro *instead of* the original, and your
data moves over through the built-in backup file. The whole migration takes
about two minutes, and your client API keys keep working unchanged.

> **Short version:** export a backup from the original → install Pro → import
> the backup. Done.

## Before you start

- Keep your original 9Router running until Pro is verified — the import reads
  a file, it never touches the original's data, so rollback is simply
  "keep using the original".
- A fresh Pro install asks you to set a dashboard password on first run. It
  does **not** inherit the original's password (importing a backup does not
  change it either) — Pro keeps its own.

## Step 1 — Export from the original 9Router

1. Open the original dashboard → **Profile** page.
2. In the **Database** section, click **Download Backup** and confirm with
   your dashboard password.
3. Save the downloaded `.json` file somewhere safe — it contains your
   provider credentials and API keys.

## Step 2 — Install 9Router Pro

Follow the **Quick Start (Pro)** in the [README](./README.md) (from source or
Docker). If Pro will take over the original's machine and port (20128), stop
the original first — or run Pro on a different port while you verify, and
swap later. Both can coexist; they are separate apps with separate data.

## Step 3 — Import the backup into Pro

1. Open the Pro dashboard → **Profile** page.
2. In the **Database** section, click **Import Backup**, pick the `.json`
   file from Step 1, and confirm with your (new) Pro dashboard password.
3. Wait for "Database imported successfully", then reload the dashboard.

Importing is safe by design:

- Pro takes a **snapshot of its own database before every import**
  (`data/db/backups/pre-import-*`, newest 3 kept), so a wrong file is never
  unrecoverable.
- Pro backups carry a format marker; importing a backup from the original —
  or from an older Pro — **never wipes Pro-only data** (prompt injections,
  key quotas, key limits): sections the file doesn't contain are left as
  they are.

## Step 4 — Verify

- **Providers** page: your connections and OAuth accounts are all there.
- **Combos** page: your combos exist; `GET /v1/models` with one of your
  existing API keys lists them.
- Send one test chat through a combo you use daily.
- **Endpoint** page: your API keys are listed with the same key values —
  clients (Hermes, Claude Code, Cursor, …) keep working against Pro's base
  URL with **no key changes**.

## What carries over — and what doesn't

| Carries over (in the backup) | Starts fresh in Pro |
| --- | --- |
| Provider connections & OAuth accounts | Prompt Injections (Pro-only feature) |
| Custom providers / nodes | Per-key token quotas |
| Combos & model aliases / custom models | Per-key rate limits (Key Limits) |
| API keys (same values) | Usage history & statistics* |
| Proxy pools | |
| Pricing | |
| Settings (incl. Token Saver toggles) | |

\* The backup format covers configuration, not historical usage rows, so
usage counters and quota/limit windows count from migration day.

Pro-only features have no source data in the original — after migrating,
set them up on the **Prompt Injection** page and per key on the **Endpoint**
page.

## Cut over and roll back

- **Cut over:** point your clients at Pro's base URL (same key), then stop
  the original. Keep the original's folder and your backup `.json` for a
  few days.
- **Roll back:** your original install was never modified — just start it
  again and point clients back. Nothing to undo on the Pro side.

## FAQ

**Does Pro auto-migrate my existing install in place?**
No — deliberately. Export/import is explicit, reversible, and works across
machines and across install styles (source ↔ Docker). It takes about two
minutes.

**Do my client API keys change?**
No. Keys import with the same values; only the base URL changes if you run
Pro somewhere else.

**Can I migrate from a fork of 9Router?**
If the fork exports the standard 9Router backup file, yes — import it the
same way. Pro-only sections simply start empty, and nothing in the file can
wipe them later.

**What if the import fails or the file looks wrong?**
Pro snapshots its database before importing, and the original install is
untouched. Fix the file (re-export from the original) and import again.
