/**
 * Redaction helpers (SPEC §6). We never ship request/response bodies, never ship
 * binding values, and scrub URL values + headers wherever a URL or header set is
 * read for telemetry. The attribute firewall is the last line of defense for
 * framework-specific fields.
 */

const SENSITIVE_SEGMENTS = new Set([
  "authorization",
  "auth",
  "cookie",
  "cookies",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "credential",
  "credentials",
  "body",
  "payload",
  "form",
  "stack",
  "stacktrace",
  "log",
]);

/** Reject content-bearing attributes even when a framework invents a new key. */
export function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[-_]/g, ".");
  if (
    normalized === "http.request.method" ||
    normalized === "http.response.status.code" ||
    normalized === "restlytics.bindings.count"
  ) {
    return false;
  }
  return normalized
    .split(".")
    .some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/**
 * Redact every query-string value, credentials, and fragments. `queryKeys` remains
 * accepted for API compatibility; privacy no longer depends on knowing secret key
 * names in advance. Best-effort parse failures drop the entire query string.
 */
export function redactUrl(
  rawUrl: string,
  _queryKeys: readonly string[],
): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    // Unparseable: drop everything after `?` to be safe.
    const q = rawUrl.indexOf("?");
    return q === -1 ? rawUrl : rawUrl.slice(0, q);
  }
}

/** Exception text is intentionally omitted; Restlytics is not a crash tracker. */
export function redactExceptionMessage(
  _message: string | undefined,
): undefined {
  return undefined;
}

/** True if a header name is in the sensitive set (case-insensitive). */
export function isSensitiveHeader(
  name: string,
  sensitive: readonly string[],
): boolean {
  const lower = name.toLowerCase();
  return sensitive.some((h) => h.toLowerCase() === lower);
}
