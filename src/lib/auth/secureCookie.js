// Secure-cookie default for auth cookies (audit item 6e, pro.29).
// Secure is the DEFAULT, not opt-in: cookies are flagged Secure unless the
// operator explicitly opts out with AUTH_COOKIE_SECURE=false (plain-HTTP
// LAN deployments that cannot do TLS). localhost is a secure context in
// browsers, so Secure cookies still work over http://localhost.
export function shouldSetSecureCookie() {
  return process.env.AUTH_COOKIE_SECURE !== "false";
}
