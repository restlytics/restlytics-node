# @restlytics/node

Framework-native observability SDK for Node.js. Captures **one trace per HTTP request**
— a root SERVER span plus CLIENT child spans for each DB query and outbound HTTP
call — plus opt-in, source-redacted application logs, and ships both signals as
**OTLP/JSON**.

> One contract, every language. This SDK conforms to the cross-language
> [`SPEC.md`](../SPEC.md): same wire format, same attribute keys, same SQL
> normalization and self-time math, same safety rules. The ingestion service
> (`apps/ingest`, validated by `packages/contract`) accepts it identically to the
> Laravel / Python / Go / … SDKs.

- **Frameworks:** Express, NestJS
- **DB:** `pg`, `mysql2` (+ a generic `recordDbQuery` for anything else)
- **Outbound HTTP:** optional, via undici/`fetch` diagnostics channels
- **Logs:** opt-in logger-agnostic API with console, Pino, and Winston-friendly hooks
- **Runtime:** Node 18+, ESM, TypeScript types included
- **Safe by design:** fire-and-forget, gzipped, ~2s timeout, swallows all errors,
  never blocks or throws into your app. No bind values; every URL query value is
  scrubbed; headers, bodies, and exception content are omitted.

## Install

```bash
npm install @restlytics/node
# optional peers — install only what you use:
npm install express            # or @nestjs/common
npm install pg                 # and/or mysql2
```

All framework/driver packages are **optional peer dependencies**: the SDK loads
fine without them and only instruments what is present.

## Configuration (`.env`)

```dotenv
# Required to actually send (empty key = SDK disables delivery silently)
RESTLYTICS_KEY=rl_xxxxxxxxxxxxxxxxxxxxxxxx
RESTLYTICS_INGEST_URL=https://ingest.restlytics.com

# Identity (resource attributes)
RESTLYTICS_SERVICE_NAME=my-api
RESTLYTICS_ENV=production

# Head-based sampling: fraction of traces to keep (0.0–1.0). Default 1.0.
RESTLYTICS_SAMPLE_RATE=1.0

# Transport: http (default) | preview | log | null
RESTLYTICS_TRANSPORT=http
RESTLYTICS_TIMEOUT_MS=2000

# Capture raw SQL text (db.query.text, capped 2048). OFF by default — may carry
# PII. The normalized, literal-free db.query.summary is ALWAYS sent; bind values
# are NEVER sent regardless of this flag.
RESTLYTICS_CAPTURE_SQL=false

# Per-instrument toggles
RESTLYTICS_INSTRUMENT_DB=true
RESTLYTICS_INSTRUMENT_HTTP=true
RESTLYTICS_INSTRUMENT_CACHE=true

# Comma-separated paths to skip entirely (trailing * wildcard supported)
RESTLYTICS_IGNORE_PATHS=/health,/healthz,/metrics

# Bound in-request span buffer (memory cap under pathological N+1)
RESTLYTICS_MAX_SPANS=2000

# Native OTLP logs are OFF by default. WARN (13) and above ship when enabled.
RESTLYTICS_LOGS=false
RESTLYTICS_LOGS_MIN_SEVERITY=13
```

Anything settable via env can also be passed to `init()`; explicit options win
over env, which wins over defaults.

## Express

```ts
import express from 'express';
import { init, expressMiddleware, instrumentPostgres } from '@restlytics/node';

const rl = init();                       // reads RESTLYTICS_* env vars
instrumentPostgres(rl);                  // wrap node-postgres (call once, at boot)

const app = express();
app.use(expressMiddleware(rl));          // opens the SERVER span, flushes on 'finish'

app.get('/users/:id', async (req, res) => {
  // any pg query here becomes a DB CLIENT child span on this request's trace
  res.json({ ok: true });
});

app.listen(3000);
```

`http.route` is recorded as the **route template** (`/users/:id`), never the raw
URL, so high-cardinality ids don't explode the rollups.

## NestJS

```ts
import { NestFactory } from '@nestjs/core';
import { init, nestInterceptor, instrumentMySQL } from '@restlytics/node';
import { AppModule } from './app.module';

const rl = init();
instrumentMySQL(rl);

const app = await NestFactory.create(AppModule);
app.useGlobalInterceptors(nestInterceptor(rl));
await app.listen(3000);
```

Prefer middleware? `nestMiddleware(rl)` is a connect-style middleware you can wire
up in a module's `configure(consumer)` with `consumer.apply(...).forRoutes('*')`.

## Database

`pg` and `mysql2` are auto-wrapped by `instrumentPostgres(rl)` /
`instrumentMySQL(rl)`. Each query becomes a DB CLIENT span carrying
`db.system.name`, the normalized `db.query.summary` (the N+1 grouping key), the
operation name, and a **count** of bindings — never the values.

For any other driver, record spans manually:

```ts
import { recordDbQuery } from '@restlytics/node';

const start = rl.tracer.current()!.nowNs();
// ... run your query ...
recordDbQuery(rl, {
  system: 'sqlite',
  sql: 'SELECT * FROM t WHERE id = ?',
  bindingsCount: 1,
  startNs: start,
  endNs: rl.tracer.current()!.nowNs(),
});
```

## Outbound HTTP (optional)

```ts
import { instrumentOutboundHttp } from '@restlytics/node';
instrumentOutboundHttp(rl); // best-effort: global fetch() / undici
```

Records an HTTP CLIENT span per outbound call with the query string of `url.full`
redacted. Best-effort — silently does nothing if the channels aren't available.

## Trace-correlated logs (opt-in)

Enable `RESTLYTICS_LOGS=true`, then use the dependency-free API from any logger:

```ts
const rl = init();

rl.log('warn', 'checkout retry for https://shop.test/pay?token=secret', {
  component: 'checkout',
  retry: 2,
});
```

The default minimum is WARN (`13`). Levels map deterministically to OTel severity:
debug/trace `5`, info `9`, notice `10`, warn `13`, error `17`, critical `18`, and
fatal/alert/emergency `21`. Numeric levels passed to `rl.log()` are interpreted as
OTel severity numbers (`1`–`24`).

Records emitted inside Restlytics request/job/command/schedule context carry its
active `traceId`, root `spanId`, and sampled flag. Records outside traced work still
ship without IDs. Node's DB and HTTP spans are created post-hoc, so the root is the
active correlation span during those operations.

The SDK scrubs credentials, emails, URL secrets, private keys, and other recognized
sensitive text before buffering; it rejects sensitive structured keys, nested
objects, request/response content, bindings, and exception data. Keep application
logging source-redacted too: no scrubber can identify every domain-specific secret
stored under an otherwise safe custom key.

### Console

```ts
import { init, instrumentConsoleLogs } from '@restlytics/node';

const rl = init();
const restoreConsole = instrumentConsoleLogs(rl);
// console.warn/error are captured and still behave normally.
// restoreConsole() removes the hook.
```

### Pino (in-process hook)

```ts
import pino from 'pino';
import { init, createPinoLogMethodHook } from '@restlytics/node';

const rl = init();
const logger = pino({ hooks: { logMethod: createPinoLogMethodHook(rl) } });
```

Use the in-process hook rather than a Pino worker-thread transport: worker threads
do not share Node `AsyncLocalStorage`, so they cannot retain trace correlation.

### Winston (format hook)

```ts
import winston from 'winston';
import { init, captureWinstonLog } from '@restlytics/node';

const rl = init();
const restlyticsFormat = winston.format((info) => {
  captureWinstonLog(rl, info);
  return info;
});
const logger = winston.createLogger({ format: restlyticsFormat() });
```

Log capture uses a 256-record memory cap, exports in batches of at most 64, and
drains on a size/time threshold, request/job completion, `flush()`, or `shutdown()`.
Transport and capture failures are swallowed and available through `onError`.

## Self-time breakdown

The SERVER span carries `restlytics.self_ns.{db,http,cache,app}` (nanoseconds),
computed via **interval-union** so overlapping/parallel children don't
double-count. `app = root_duration − union(all children)`, clamped ≥ 0.

## Background jobs, commands, and schedules

Use the background wrappers at the framework boundary. Names must be stable
handler/signature names—never job ids, arguments, or payload data.

```ts
await rl.runJob(
  {
    name: 'billing.reconcile',
    system: 'redis',
    destination: 'billing',
    attempt: job.attemptsMade + 1,
    traceparent: job.data.__restlytics?.traceparent,
  },
  () => reconcile(job.data),
);

await rl.runEnqueue(
  { system: 'redis', destination: 'billing' },
  payload,
  (carrier) => queue.add('billing.reconcile', carrier),
);
```

`runCommand` records the returned exit code and `runSchedule` records the cron
expression as an attribute. Job roots are `CONSUMER` spans; commands and
schedules are `SERVER` roots. Enqueue propagation uses a namespaced
`__restlytics` carrier, honors the upstream sampling decision, and records the
async boundary as both parentage and a span link. Queue time is reported in
`restlytics.self_ns.queue`. Errors set status only; exception content and job
payloads are never exported.

## Transports

| `RESTLYTICS_TRANSPORT` | behaviour |
|---|---|
| `http` (default) | gzip + fire-and-forget POST to `{ingestUrl}/v1/traces` and opt-in `/v1/logs` |
| `preview` | structured local-only report with the production payload, sampling rate, redaction policy, and byte sizes; never opens a socket and does not require a key |
| `log` | pretty-print the OTLP payload (local debugging) |
| `null` | no-op; records payloads in memory for tests |

Before connecting production data, run a representative request with
`RESTLYTICS_TRANSPORT=preview`. The report explicitly states
`networkRequestMade: false`, shows the redacted payload, counts spans, and reports
both uncompressed JSON and production gzip sizes. Sampling remains active, so use
`RESTLYTICS_SAMPLE_RATE=1` for a deterministic one-request review.

### Custom exporters

Use the provider-neutral `exporter` option when a design partner needs to route
telemetry through its own collector, queue, or test harness:

```ts
import { init, type Exporter } from '@restlytics/node';

const exporter: Exporter = {
  exportTraces: (otlpRequest) => collector.enqueue('traces', otlpRequest),
  exportLogs: (otlpRequest) => collector.enqueue('logs', otlpRequest),
  flush: (timeoutMs) => collector.flush(timeoutMs),
  shutdown: (timeoutMs) => collector.shutdown(timeoutMs),
};

const rl = init({ exporter, logs: true });
```

Both callbacks receive the same production-shaped, source-redacted OTLP/JSON
objects used by the built-in HTTP transport. The SDK key and resolved tenant
identity are never passed to an exporter or added to either payload. Exporter
callbacks may be synchronous or return a promise; thrown errors, rejected
promises, and lifecycle timeouts are contained and reported through `onError`.
`exportLogs` is optional for compatibility with trace-only exporters. Keep the
callback bounded (normally enqueue locally) and use `flush`/`shutdown` for
graceful process termination. The older `transport` object option remains
supported for compatibility; new provider integrations should use `exporter`.

### Delivery reliability and shutdown

The HTTP transport uses one worker and a shared fixed 64-batch queue. Trace and
log sends only enqueue; when saturated the transport drops the new batch instead
of blocking or growing memory. There are no delivery retries. Timeouts, encoding
failures, saturation, and sends after shutdown are observable without exposing
payloads:

```ts
const snapshot = rl.diagnostics();
console.log(snapshot?.droppedBatches, snapshot?.failedBatches);
console.log(rl.logger.diagnostics().droppedRecords);

process.once('SIGTERM', async () => {
  await rl.shutdown(2_000); // bounded graceful flush
});
```

## Development

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # node:test runner (contract, sql, intervals, redaction)
```

## Cross-language conformance

CI pins [`restlytics/sdk-conformance@v1.1.0`](https://github.com/restlytics/sdk-conformance)
and compares the vendored fixture before testing. The suite proves exact semantic OTLP output,
W3C propagation, root sampling, source redaction, and error-status behavior shared by all seven SDKs.
The release gate also boots a real Express application and sends its request telemetry over gzip HTTP
to a deployed-compatible ingest server. It proves route templates, trace continuation, 202/503 handling,
error status, and that the project key plus request secrets stay out of the payload. Express is beta-validated;
NestJS remains preview until it passes the same real-app gate.

## License

MIT
