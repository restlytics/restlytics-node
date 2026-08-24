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
  "err",
  "error",
  "exception",
  "binding",
  "bindings",
]);

const REDACTED = "[REDACTED]";

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
  if (
    normalized.startsWith("http.request.header.") ||
    normalized.startsWith("http.response.header.") ||
    normalized.startsWith("exception.") ||
    normalized.startsWith("log.")
  ) {
    return true;
  }
  return normalized
    .split(".")
    .some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

function redactPathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return REDACTED;
  }
  if (
    /@/.test(decoded) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded) ||
    /^[0-9a-f]{24,}$/i.test(decoded) ||
    /^[A-Za-z0-9_-]{32,}$/.test(decoded) ||
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded)
  ) {
    return REDACTED;
  }
  return segment;
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
    url.pathname = url.pathname
      .split("/")
      .map((segment) => redactPathSegment(segment))
      .join("/");
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    // Unparseable: drop everything after `?` to be safe.
    const q = rawUrl.indexOf("?");
    return q === -1 ? rawUrl : rawUrl.slice(0, q);
  }
}

/** Best-effort source scrubber for host-authored log text and safe attributes. */
export function redactText(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gi,
      REDACTED,
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, REDACTED)
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(
      /\b(authorization|cookie|password|passwd|secret|token|access_token|refresh_token|api[_-]?key|credential|bindings?|request[_ .-]?body|response[_ .-]?body|payload|exception|stack)s?\b\s*[:=]\s*([^\s,;&]+)/gi,
      REDACTED,
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url, []));
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
