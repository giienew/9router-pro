import { NextResponse } from "next/server";

// Map an unknown error to a stable, client-safe error body (M-3).
// The raw message is logged server-side only; the client sees a stable code
// plus a generic message — never host filesystem paths or upstream
// internals. Call sites pass the code/message that fits their route; the
// defaults are deliberately vague.
export function apiErrorResponse(
  error,
  { code = "internal_error", message = "An error occurred. Please try again.", status = 500 } = {}
) {
  console.error(`[api:${code}]`, error);
  return NextResponse.json({ error: { code, message } }, { status });
}

// Plain body form for routes that add their own fields around the error
// (e.g. { error, servers, total } or { healthy, checks, error }).
export function apiErrorBody(
  error,
  { code = "internal_error", message = "An error occurred. Please try again." } = {}
) {
  console.error(`[api:${code}]`, error);
  return { error: { code, message } };
}
