// Shared cap for dashboard bulk-import endpoints (M-1). Mirrors the
// live-only Kiro bulk-import cap (MAX_KIRO_BULK_ITEMS = 50 in
// src/lib/oauth/kiroBulk.js) so every bulk import behaves the same:
// at most 50 items per request, with per-item results, so one huge batch
// can never hold the server in a long sequential write loop.

export const MAX_BULK_IMPORT_ITEMS = 50;
