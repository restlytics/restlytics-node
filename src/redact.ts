/**
 * Redaction helpers (SPEC §6). We never ship request/response bodies, never ship
 * binding values, and scrub sensitive query-string keys + headers wherever a URL
 * or header set is read for telemetry.
 */

/**
 * Redact sensitive query-string parameters from a full URL. Values for keys in
 * `queryKeys` (case-insensitive) are replaced with `REDACTED`. Best-effort: if the
 * URL can't be parsed we strip the query string entirely rather than risk leaking.
 */
export function redactUrl(rawUrl: string, queryKeys: readonly string[]): string {
  try {
    const url = new URL(rawUrl);
    if (url.search === '') return url.toString();
    const lowerKeys = new Set(queryKeys.map((k) => k.toLowerCase()));
    for (const key of [...url.searchParams.keys()]) {
      if (lowerKeys.has(key.toLowerCase())) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    // Unparseable: drop everything after `?` to be safe.
    const q = rawUrl.indexOf('?');
    return q === -1 ? rawUrl : rawUrl.slice(0, q);
  }
}

/** True if a header name is in the sensitive set (case-insensitive). */
export function isSensitiveHeader(name: string, sensitive: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return sensitive.some((h) => h.toLowerCase() === lower);
}
