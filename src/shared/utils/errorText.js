// Read a human-readable error message from an API payload whose error may
// be a plain string (legacy routes) or { code, message } (canonical M-3
// shape). Used by dashboard clients so a shape change never renders
// "[object Object]".
export function errorText(data, fallback = "An error occurred") {
  const err = data?.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && typeof err.message === "string" && err.message) {
    return err.message;
  }
  return fallback;
}
