import { normalize, operationOf } from '../sql.js';
import { SpanKind } from '../otlp.js';
import type { Tracer } from '../tracer.js';

/**
 * Shared DB-span recording used by the pg / mysql2 wrappers and the public
 * manual API. Builds a CLIENT span with `restlytics.category="db"` and the DB
 * semantic attributes (SPEC §4). Bindings are COUNTED, never sent; the statement
 * is normalized; raw SQL is attached only when `captureSql` is on (capped 2048).
 *
 * `startNs`/`endNs` are absolute epoch nanoseconds. Callers that only have an
 * elapsed duration should back-date the start: `endNs - elapsedNs`.
 */
export interface RecordQueryInput {
  system: 'postgresql' | 'mysql' | 'sqlite' | string;
  sql: string;
  /** Number of bind parameters — counted only, NEVER the values. */
  bindingsCount?: number;
  startNs: bigint;
  endNs: bigint;
  /** Logical database / schema name, if known. */
  namespace?: string;
  /** Mark the span as errored (e.g. a failed query). */
  error?: unknown;
}

const MAX_SQL_TEXT = 2048;

export function recordQuery(tracer: Tracer, input: RecordQueryInput): void {
  const trace = tracer.current();
  if (!trace || !trace.sampled || trace.rootSpan === null) return;
  if (!tracer.config.instruments.db) return;

  try {
    const summary = normalize(input.sql);
    const op = operationOf(input.sql);

    const name = op ? `${op} ${input.system}` : `query ${input.system}`;
    const span = trace.addChild(name, 'db', input.startNs, input.endNs, SpanKind.CLIENT);
    if (span === null) return;

    trace.incrementDbQueryCount();

    span.setString('db.system.name', input.system);
    span.setString('db.query.summary', summary);
    if (op) span.setString('db.operation.name', op);
    if (input.namespace) span.setString('db.namespace', input.namespace);
    if (typeof input.bindingsCount === 'number') {
      span.setInt('restlytics.bindings_count', input.bindingsCount);
    }
    // Raw SQL is opt-in only (may contain PII); always capped.
    if (tracer.config.captureSql) {
      span.setString('db.query.text', input.sql.slice(0, MAX_SQL_TEXT));
    }
    if (input.error !== undefined) {
      span.setStatus(2, errorMessage(input.error));
    }
  } catch (err) {
    tracer.config.onError?.('restlytics: recordQuery failed', err);
  }
}

/** Count bind parameters from common driver shapes without ever reading values. */
export function countBindings(values: unknown): number | undefined {
  if (Array.isArray(values)) return values.length;
  if (values && typeof values === 'object') return Object.keys(values).length;
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'query error';
}
