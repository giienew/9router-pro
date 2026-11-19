// Server-side store for device-code PKCE verifiers (audit item 6b).
// The verifier must never leave the server in a JSON response: the
// device-code endpoint stores it keyed by device_code (MiniMax polls with
// the user_code instead, so that is the fallback key), and the poll
// endpoint reads it back. Entries expire after 15 minutes — device codes
// themselves live ~10-15 min — and are consumed on a successful poll, so
// a captured device code cannot be replayed for a second exchange.
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

const sessions = new Map(); // deviceCode → { codeVerifier, provider, createdAt }

export function storeDeviceCodeSession(deviceCode, { codeVerifier, provider } = {}) {
  if (!deviceCode || !codeVerifier) return false;
  sessions.set(deviceCode, { codeVerifier, provider: provider || null, createdAt: Date.now() });
  return true;
}

export function lookupDeviceCodeSession(deviceCode) {
  if (!deviceCode) return null;
  const s = sessions.get(deviceCode);
  if (!s) return null;
  if (Date.now() - s.createdAt > DEVICE_CODE_TTL_MS) {
    sessions.delete(deviceCode);
    return null;
  }
  return s;
}

export function consumeDeviceCodeSession(deviceCode) {
  const s = lookupDeviceCodeSession(deviceCode);
  if (s) sessions.delete(deviceCode);
  return s;
}

export function __clearDeviceCodeSessionsForTests() {
  sessions.clear();
}
