// Request-id correlation (D6): one id per client request, carried
// through usage rows (usageHistory.requestId), request-detail records
// (their id), server logs (reqTag is session-scoped, not request-scoped),
// and back to the client as the `x-9router-request-id` response header.
// A client that passes its own `x-9router-request-id` keeps it (sanitised);
// otherwise the server mints one. The id is opaque and random — it
// carries no key, account, or user information.
export const REQUEST_ID_HEADER = "x-9router-request-id";

const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function newRequestId() {
  return `req_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export function requestIdFromRequest(request) {
  try {
    const incoming = request?.headers?.get?.(REQUEST_ID_HEADER);
    if (incoming && CLIENT_ID_RE.test(incoming.trim())) return incoming.trim();
  } catch { /* a header read must never fail the request */ }
  return newRequestId();
}

// Return a copy of `response` with the request-id header set. Never
// throws and never mutates the original response; a null response
// passes through so error paths that return nothing stay nothing.
export function attachRequestId(response, requestId) {
  if (!response || !requestId) return response;
  try {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
