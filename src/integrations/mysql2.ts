import { createRequire } from 'node:module';
import { recordQuery, countBindings } from './db.js';
import type { Tracer } from '../tracer.js';

/**
 * `mysql2` instrumentation (SPEC §8: "mysql2 query wrap").
 *
 * Wraps `Connection.prototype.query` and `.execute` so each statement records a
 * DB CLIENT span on the active request trace. mysql2's callback API is the common
 * path; the promise API (`mysql2/promise`) is built on the same Connection class,
 * so patching the base prototype covers both. Bindings are counted, never read.
 *
 * `mysql2` is an OPTIONAL peer — passed in or dynamically required, never imported
 * for types. Idempotent.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const requirePeer = createRequire(import.meta.url);
const PATCHED = Symbol.for('restlytics.mysql2.patched');

export interface InstrumentMysql2Options {
  /** The `mysql2` module. Auto-required if omitted. */
  mysql2?: any;
}

/**
 * Patch mysql2. Returns an `uninstrument()` that restores the originals.
 */
export function instrumentMysql2(tracer: Tracer, opts: InstrumentMysql2Options = {}): () => void {
  if (!tracer.config.instruments.db) return () => {};

  let mysql2 = opts.mysql2;
  if (!mysql2) {
    try {
      mysql2 = requirePeer('mysql2');
    } catch (err) {
      tracer.config.onError?.('restlytics: mysql2 not found; skipping instrumentation', err);
      return () => {};
    }
  }

  // Resolve the base Connection prototype (mysql2 exposes it a couple of ways).
  const ConnProto: any =
    mysql2?.Connection?.prototype ??
    safeRequireProto('mysql2/lib/connection.js') ??
    safeRequireProto('mysql2/lib/connection');

  if (!ConnProto) {
    tracer.config.onError?.('restlytics: mysql2 Connection prototype not found');
    return () => {};
  }
  if (ConnProto[PATCHED]) {
    return () => {};
  }

  const restorers: Array<() => void> = [];
  for (const method of ['query', 'execute'] as const) {
    if (typeof ConnProto[method] !== 'function') continue;
    const original = ConnProto[method];
    ConnProto[method] = wrap(tracer, original);
    restorers.push(() => {
      ConnProto[method] = original;
    });
  }
  ConnProto[PATCHED] = true;

  return function uninstrument() {
    for (const restore of restorers) restore();
    delete ConnProto[PATCHED];
  };

  function safeRequireProto(id: string): any {
    try {
      const mod = requirePeer(id);
      return mod?.prototype ?? mod?.default?.prototype;
    } catch {
      return undefined;
    }
  }
}

function wrap(tracer: Tracer, original: (...args: any[]) => any) {
  return function patched(this: any, ...args: any[]): any {
    const trace = tracer.current();
    if (!trace || !trace.sampled || trace.rootSpan === null) {
      return original.apply(this, args);
    }

    const { sql, bindingsCount } = describe(args);
    if (sql === undefined) {
      return original.apply(this, args);
    }

    const startNs = trace.nowNs();
    const namespace: string | undefined = this?.config?.database;

    const finish = (error?: unknown) => {
      recordQuery(tracer, {
        system: 'mysql',
        sql,
        bindingsCount,
        startNs,
        endNs: trace.nowNs(),
        namespace,
        error,
      });
    };

    // mysql2 callback style: the last function arg is (err, results, fields).
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last;
      args[args.length - 1] = function wrappedCb(this: any, err: any, ...rest: any[]) {
        finish(err ?? undefined);
        return cb.call(this, err, ...rest);
      };
      return original.apply(this, args);
    }

    // Promise style (mysql2/promise) returns a thenable.
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
    // Callback API without a callback returns a Query (EventEmitter); hook its end.
    if (result && typeof result.once === 'function') {
      let done = false;
      const settle = (error?: unknown) => {
        if (done) return;
        done = true;
        finish(error);
      };
      result.once('error', settle);
      result.once('end', () => settle());
      return result;
    }
    finish();
    return result;
  };
}

/** Extract the SQL text and binding count from mysql2's query/execute signature. */
function describe(args: any[]): { sql: string | undefined; bindingsCount: number | undefined } {
  const first = args[0];
  if (typeof first === 'string') {
    // query(sql, values?, cb?)
    const values = Array.isArray(args[1]) ? args[1] : undefined;
    return { sql: first, bindingsCount: countBindings(values) };
  }
  if (first && typeof first === 'object') {
    // query({ sql, values })
    const sql = typeof first.sql === 'string' ? first.sql : undefined;
    return { sql, bindingsCount: countBindings(first.values) };
  }
  return { sql: undefined, bindingsCount: undefined };
}
