/**
 * SQL normalization → a literal-free template string.
 *
 * Two jobs:
 *  1. PII / redaction — strip every literal so we NEVER ship customer values
 *     (emails, tokens, ids) inside `db.query.summary`. Only the shape survives.
 *  2. N+1 grouping — collapse the query down to a stable fingerprint so that
 *     `SELECT * FROM users WHERE id = 1` and `... id = 2` map to the same key.
 *     `IN (?, ?, ?)` lists of varying length also collapse to `IN (?)` so a
 *     batched query and its single-row cousin don't fragment the grouping.
 *
 * This is deliberately a best-effort lexical normalizer, not a real SQL parser —
 * it must be fast (runs on every query) and never throw. The algorithm is
 * identical across every restlytics SDK (see SPEC §5).
 */

/**
 * Normalize a raw SQL string into a stable, literal-free template.
 */
export function normalize(sql: string): string {
  let s = sql;

  // Drop string literals: single- and double-quoted, with escaped-quote support.
  // Replace with `?` so they read like positional bindings.
  s = s.replace(/'(?:[^'\\]|\\.|'')*'/gs, '?');
  s = s.replace(/"(?:[^"\\]|\\.|"")*"/gs, '?');

  // Existing positional/named placeholders all normalize to `?`. Done BEFORE
  // numeric stripping so `$1`/`?1` are consumed whole (otherwise `$1` → `$?`).
  s = s.replace(/\?\d+/g, '?'); // ?1, ?2 (some drivers)
  s = s.replace(/[:$]\w+/g, '?'); // :name, $1, :id

  // Drop numeric literals (hex, decimals, scientific, ints). Use word boundaries
  // so we don't mangle identifiers like `column2`.
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '?');
  s = s.replace(/\b\d+\.\d+(?:[eE][+-]?\d+)?\b/g, '?');
  s = s.replace(/\b\d+\b/g, '?');

  // Collapse `IN (?, ?, ?)` → `IN (?)` so list length doesn't fragment groups.
  s = s.replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (?)');

  // Collapse multi-row VALUES tuples: (?, ?), (?, ?) → (?)
  s = s.replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))+/g, '(?)');
  s = s.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)');

  // Squash all whitespace runs (incl. newlines) into single spaces, then trim.
  s = s.replace(/\s+/g, ' ').trim();

  // Lowercase so casing differences don't fragment the grouping key.
  return s.toLowerCase();
}

/**
 * Best-effort extraction of the leading SQL operation keyword
 * (`select`, `insert`, `update`, `delete`, …) for `db.operation.name`.
 */
export function operationOf(sql: string): string | undefined {
  const m = /^\s*([a-zA-Z]+)/.exec(sql);
  return m ? m[1]!.toLowerCase() : undefined;
}
