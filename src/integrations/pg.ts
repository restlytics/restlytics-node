import { createRequire } from 'node:module';
import { recordQuery, countBindings } from './db.js';
import type { Tracer } from '../tracer.js';

/** ESM-safe `require` rooted at this module, used to lazily load optional peers. */
const requirePeer = createRequire(import.meta.url);

/**
 * `pg` (node-postgres) instrumentation (SPEC §8: "pg query wrap").
 *
 * Wraps `Client.prototype.query` (Pool delegates to it) so every query records a
 * DB CLIENT span on the active request trace. We time with the monotonic clock
 * and record on completion of the returned promise. Bindings are counted, never
 * read. `pg` is an OPTIONAL peer, so the module is passed in (or dynamically
 * required) and never imported for types.
 *
 * Idempotent: re-instrumenting the same module is a no-op.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const PATCHED = Symbol.for('restlytics.pg.patched');

export interface InstrumentPgOptions {
  /** The `pg` module (`import pg from 'pg'` / `require('pg')`). Auto-required if omitted. */
  pg?: any;
}

/**
 * Patch node-postgres. Returns an `uninstrument()` that restores the original.
 */
export function instrumentPg(tracer: Tracer, opts: InstrumentPgOptions = {}): () => void {
  if (!tracer.config.instruments.db) return () => {};

  let pg = opts.pg;
  if (!pg) {
    try {
      pg = requirePeer('pg');
    } catch (err) {
      tracer.config.onError?.('restlytics: pg not found; skipping instrumentation', err);
      return () => {};
    }
  }

  const ClientProto = pg?.Client?.prototype;
  if (!ClientProto || typeof ClientProto.query !== 'function') {
    return () => {};
  }
  if ((ClientProto as any)[PATCHED]) {
    return () => {};
  }

  const original = ClientProto.query;
  (ClientProto as any)[PATCHED] = true;

  ClientProto.query = function patchedQuery(this: any, ...args: any[]): any {
    const trace = tracer.current();
    // Outside a sampled request: pass straight through with zero overhead.
    if (!trace || !trace.sampled || trace.rootSpan === null) {
      return original.apply(this, args);
    }

    const { sql, bindingsCount } = describe(args);
    if (sql === undefined) {
      return original.apply(this, args);
    }

    const startNs = trace.nowNs();
    const namespace: string | undefined = this?.database ?? this?.connectionParameters?.database;

    const finish = (error?: unknown) => {
      recordQuery(tracer, {
        system: 'postgresql',
        sql,
        bindingsCount,
        startNs,
        endNs: trace.nowNs(),
        namespace,
        error,
      });
    };

    // pg.query returns a Promise when no callback is supplied. If a callback is
    // passed (last arg is a function), wrap it instead.
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last;
      args[args.length - 1] = function wrappedCb(this: any, err: any, ...rest: any[]) {
        finish(err ?? undefined);
        return cb.call(this, err, ...rest);
      };
      return original.apply(this, args);
    }

    let result: any;
    try {
      result = original.apply(this, args);
    } catch (err) {
      finish(err);
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value: any) => {
          finish();
          return value;
        },
        (err: any) => {
          finish(err);
          throw err;
        },
      );
    }
    // Non-promise (e.g. a query stream / Submittable): record immediately.
    finish();
    return result;
  };

  return function uninstrument() {
    ClientProto.query = original;
    delete (ClientProto as any)[PATCHED];
  };
}

/** Extract the SQL text and binding count from pg.query's flexible signature. */
function describe(args: any[]): { sql: string | undefined; bindingsCount: number | undefined } {
  const first = args[0];
  if (typeof first === 'string') {
    // query(text, values?, cb?)
    const values = Array.isArray(args[1]) ? args[1] : undefined;
    return { sql: first, bindingsCount: countBindings(values) };
  }
  if (first && typeof first === 'object') {
    // query({ text, values }) or a prepared-statement config / Submittable
    const sql = typeof first.text === 'string' ? first.text : undefined;
    return { sql, bindingsCount: countBindings(first.values) };
  }
  return { sql: undefined, bindingsCount: undefined };
}
