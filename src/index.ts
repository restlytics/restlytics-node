/**
 * @restlytics/node — public API.
 *
 * Typical setup (Express):
 *
 *   import { init, expressMiddleware, instrumentPg } from '@restlytics/node';
 *   const rl = init();                 // reads RESTLYTICS_* env vars
 *   instrumentPg(rl);                  // wrap node-postgres
 *   app.use(expressMiddleware(rl));    // open SERVER span + flush on res 'finish'
 *
 * Everything is fire-and-forget and never throws into the host app (SPEC §6).
 */

import { resolveConfig, type RestlyticsOptions, type ResolvedConfig } from './config.js';
import { Tracer } from './tracer.js';
import {
  HttpTransport,
  NullTransport,
  LogTransport,
  type Transport,
} from './transport.js';
import { createExpressMiddleware, type ExpressMiddlewareOptions } from './integrations/express.js';
import { createNestMiddleware, RestlyticsInterceptor } from './integrations/nest.js';
import { instrumentPg, type InstrumentPgOptions } from './integrations/pg.js';
import { instrumentMysql2, type InstrumentMysql2Options } from './integrations/mysql2.js';
import { instrumentHttp } from './integrations/http.js';
import { recordQuery, type RecordQueryInput } from './integrations/db.js';

/** The configured SDK handle returned by {@link init}. Pass it to the integrations. */
export class Restlytics {
  readonly tracer: Tracer;

  constructor(
    readonly config: ResolvedConfig,
    readonly transport: Transport,
  ) {
    this.tracer = new Tracer(config, transport);
  }

  /** Manually record a DB query span on the active request (generic API, SPEC §8). */
  recordQuery(input: RecordQueryInput): void {
    recordQuery(this.tracer, input);
  }
}

/** Choose a transport from config. `http` is the default fire-and-forget sender. */
function makeTransport(config: ResolvedConfig): Transport {
  switch (config.transport) {
    case 'null':
      return new NullTransport();
    case 'log':
      return new LogTransport();
    case 'http':
    default:
      return new HttpTransport(config.ingestUrl, config.key, config.timeoutMs, config.onError);
  }
}

/**
 * Initialize the SDK. Reads `RESTLYTICS_*` env vars (SPEC §7), overridable via
 * `options`. Returns a {@link Restlytics} handle to pass to the integrations.
 * A custom `transport` can be supplied (e.g. for tests).
 */
export function init(options: RestlyticsOptions & { transport?: Transport } = {}): Restlytics {
  const { transport: explicitTransport, ...rest } = options;
  const config = resolveConfig(rest);
  const transport = explicitTransport ?? makeTransport(config);
  return new Restlytics(config, transport);
}

// --- Integration entry points (accept either the handle or the bare Tracer) ---

function tracerOf(rl: Restlytics | Tracer): Tracer {
  return rl instanceof Restlytics ? rl.tracer : rl;
}

/** Express middleware: opens the SERVER span and flushes on `res` `finish`. */
export function expressMiddleware(rl: Restlytics | Tracer, opts?: ExpressMiddlewareOptions) {
  return createExpressMiddleware(tracerOf(rl), opts);
}

/** NestJS connect-style middleware (register with `consumer.apply(...)`). */
export function nestMiddleware(rl: Restlytics | Tracer) {
  return createNestMiddleware(tracerOf(rl));
}

/** Build a NestJS interceptor instance bound to this SDK. */
export function nestInterceptor(rl: Restlytics | Tracer): RestlyticsInterceptor {
  return new RestlyticsInterceptor(tracerOf(rl));
}

/** Instrument node-postgres (`pg`). Returns an uninstrument function. */
export function instrumentPostgres(rl: Restlytics | Tracer, opts?: InstrumentPgOptions): () => void {
  return instrumentPg(tracerOf(rl), opts);
}

/** Instrument `mysql2`. Returns an uninstrument function. */
export function instrumentMySQL(rl: Restlytics | Tracer, opts?: InstrumentMysql2Options): () => void {
  return instrumentMysql2(tracerOf(rl), opts);
}

/** Instrument outbound HTTP via undici/fetch diagnostics channels (best-effort). */
export function instrumentOutboundHttp(rl: Restlytics | Tracer): () => void {
  return instrumentHttp(tracerOf(rl));
}

/** Record a DB query span manually on the active request (generic API). */
export function recordDbQuery(rl: Restlytics | Tracer, input: RecordQueryInput): void {
  recordQuery(tracerOf(rl), input);
}

// --- Re-exports for advanced / direct use ------------------------------------

export { resolveConfig } from './config.js';
export type {
  RestlyticsOptions,
  ResolvedConfig,
  TransportName,
  RedactionConfig,
  InstrumentToggles,
} from './config.js';
export { Tracer, RequestTrace, sampleDecision } from './tracer.js';
export {
  HttpTransport,
  NullTransport,
  LogTransport,
  type Transport,
  type ErrorReporter,
} from './transport.js';
export {
  Span,
  SpanKind,
  StatusCode,
  buildPayload,
  SDK_NAME,
  SDK_LANGUAGE,
  SDK_VERSION,
  type ExportTraceServiceRequest,
  type OtlpSpan,
  type KeyValue,
  type AnyValue,
  type SpanCategory,
} from './otlp.js';
export * as ids from './ids.js';
export { normalize as normalizeSql, operationOf } from './sql.js';
export { unionLength, type Interval } from './intervals.js';
export { recordQuery, type RecordQueryInput } from './integrations/db.js';
export { createExpressMiddleware, type ExpressMiddlewareOptions } from './integrations/express.js';
export { createNestMiddleware, RestlyticsInterceptor } from './integrations/nest.js';
export { instrumentPg, type InstrumentPgOptions } from './integrations/pg.js';
export { instrumentMysql2, type InstrumentMysql2Options } from './integrations/mysql2.js';
export { instrumentHttp } from './integrations/http.js';
export { redactUrl, isSensitiveHeader } from './redact.js';
