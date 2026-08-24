# @restlytics/node

Framework-native tracing SDK for Node.js. Captures **one trace per HTTP request**
— a root SERVER span plus CLIENT child spans for each DB query and outbound HTTP
call — and ships them to the restlytics ingestion service as **OTLP/JSON**.

> One contract, every language. This SDK conforms to the cross-language
> [`SPEC.md`](../SPEC.md): same wire format, same attribute keys, same SQL
> normalization and self-time math, same safety rules. The ingestion service
> (`apps/ingest`, validated by `packages/contract`) accepts it identically to the
> Laravel / Python / Go / … SDKs.

- **Frameworks:** Express, NestJS
- **DB:** `pg`, `mysql2` (+ a generic `recordDbQuery` for anything else)
- **Outbound HTTP:** optional, via undici/`fetch` diagnostics channels
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

# Transport: http (default) | log | null
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
| `http` (default) | gzip + fire-and-forget POST to `{ingestUrl}/v1/traces` after the response is flushed |
| `preview` | structured local-only report with the production payload, sampling rate, redaction policy, and byte sizes; never opens a socket and does not require a key |
| `log` | pretty-print the OTLP payload (local debugging) |
| `null` | no-op; records payloads in memory for tests |

Before connecting production data, run a representative request with
`RESTLYTICS_TRANSPORT=preview`. The report explicitly states
`networkRequestMade: false`, shows the redacted payload, counts spans, and reports
both uncompressed JSON and production gzip sizes. Sampling remains active, so use
`RESTLYTICS_SAMPLE_RATE=1` for a deterministic one-request review.

### Delivery reliability and shutdown

The HTTP transport uses one worker and a fixed 64-batch queue. `send()` only
enqueues; when saturated it drops the new batch instead of blocking or growing
memory. There are no delivery retries. Timeouts, encoding failures, saturation,
and sends after shutdown are observable without exposing payloads:

```ts
const snapshot = rl.diagnostics();
console.log(snapshot?.droppedBatches, snapshot?.failedBatches);

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
