import { AsyncLocalStorage } from 'node:async_hooks';
import * as Ids from './ids.js';
import { unionLength, type Interval } from './intervals.js';
import {
  Span,
  SpanKind,
  StatusCode,
  buildPayload,
  type SpanCategory,
} from './otlp.js';
import type { Transport } from './transport.js';
import type { ResolvedConfig } from './config.js';

/**
 * Per-request trace state. One of these is created at request start and lives in
 * AsyncLocalStorage for the duration of the request, so DB / HTTP / cache
 * instrumentation can find "the current request" without the host passing context
 * around. AsyncLocalStorage gives us per-request isolation even under heavy
 * concurrency (SPEC §6) — there is no shared mutable singleton to leak across
 * requests the way a long-lived worker would.
 *
 * Timing model: we use `process.hrtime.bigint()` (monotonic) for DURATIONS — it
 * isn't affected by NTP/clock adjustments — and anchor it to a single wall-clock
 * reading so we can emit absolute epoch-nanosecond timestamps. Each absolute
 * timestamp is `wallAnchorNs + (hrtimeNow - hrtimeAnchor)`.
 */
export class RequestTrace {
  readonly traceId: string;
  readonly sampled: boolean;
  rootSpan: Span | null = null;

  private readonly children: Span[] = [];
  private dbQueryCount = 0;

  private readonly wallAnchorNs: bigint;
  private readonly hrtimeAnchor: bigint;

  constructor(
    private readonly config: ResolvedConfig,
    traceId: string,
    sampled: boolean,
  ) {
    this.traceId = traceId;
    this.sampled = sampled;
    // Anchor wall-clock <-> monotonic clocks together.
    this.wallAnchorNs = BigInt(Date.now()) * 1_000_000n;
    this.hrtimeAnchor = process.hrtime.bigint();
  }

  /** Absolute current time in epoch nanoseconds, derived from the monotonic clock. */
  nowNs(): bigint {
    return this.wallAnchorNs + (process.hrtime.bigint() - this.hrtimeAnchor);
  }

  rootSpanId(): string | undefined {
    return this.rootSpan?.spanId;
  }

  /** Open the root SERVER span. Called once at request start. */
  openRoot(name: string, parentSpanId: string | undefined): Span | null {
    if (!this.sampled) return null;
    const now = this.nowNs();
    this.rootSpan = new Span({
      traceId: this.traceId,
      spanId: Ids.spanId(),
      parentSpanId,
      name,
      kind: SpanKind.SERVER,
      startUnixNano: now,
      endUnixNano: now,
    });
    return this.rootSpan;
  }

  /**
   * Create a CLIENT child span over an absolute [startNs, endNs] window.
   *
   * DB/HTTP/cache instrumentation often only learns of a span AFTER it finished,
   * so callers back-date the start. Returns null when not sampled or when the
   * buffer cap is hit (telemetry must never grow unbounded — SPEC §6).
   */
  addChild(
    name: string,
    category: SpanCategory,
    startNs: bigint,
    endNs: bigint,
    kind: number = SpanKind.CLIENT,
  ): Span | null {
    if (!this.sampled || this.rootSpan === null) return null;
    if (this.children.length >= this.config.maxSpans) return null;

    const span = new Span({
      traceId: this.traceId,
      spanId: Ids.spanId(),
      parentSpanId: this.rootSpan.spanId,
      name,
      kind,
      startUnixNano: startNs,
      endUnixNano: endNs,
    });
    span.setString('restlytics.category', category);
    this.children.push(span);
    return span;
  }

  incrementDbQueryCount(): void {
    this.dbQueryCount++;
  }

  /**
   * Close the root span, compute self-time rollups, build the OTLP payload and
   * flush it through the transport (fire-and-forget). Any failure is swallowed.
   */
  finish(transport: Transport): void {
    if (!this.sampled || this.rootSpan === null) return;
    try {
      this.rootSpan.setEnd(this.nowNs());
      this.attachSelfTime();
      this.rootSpan.setInt('restlytics.db_query_count', this.dbQueryCount);
      this.rootSpan.setString('restlytics.category', 'app');

      const payload = buildPayload(this.config.serviceName, this.config.env, [
        this.rootSpan,
        ...this.children,
      ]);
      transport.send(payload);
    } catch (err) {
      // Telemetry must never throw into the host application.
      this.config.onError?.('restlytics: finish failed', err);
    }
  }

  /** Compute and attach restlytics.self_ns.{db,http,cache,app} to the root span. */
  private attachSelfTime(): void {
    const root = this.rootSpan;
    if (root === null) return;

    const rootStart = root.startUnixNano;
    const rootDur = root.durationNs();

    const byCat: Record<'db' | 'http' | 'cache' | 'app', Interval[]> = {
      db: [],
      http: [],
      cache: [],
      app: [],
    };
    const all: Interval[] = [];

    for (const s of this.children) {
      // Normalize to offsets from root start; clamp inverted intervals (skew).
      let start = s.startUnixNano - rootStart;
      let end = s.endUnixNano - rootStart;
      if (end < start) end = start;
      all.push([start, end]);

      const cat = categoryOf(s);
      byCat[cat].push([start, end]);
    }

    const selfDb = unionLength(byCat.db);
    const selfHttp = unionLength(byCat.http);
    const selfCache = unionLength(byCat.cache);
    // app self-time = explicit app-category child time + the root's own exclusive
    // (uncovered) time. Mirrors the ingestion service's computation.
    const uncovered = rootDur - unionLength(all);
    const selfApp = unionLength(byCat.app) + (uncovered > 0n ? uncovered : 0n);

    root.setInt('restlytics.self_ns.db', selfDb);
    root.setInt('restlytics.self_ns.http', selfHttp);
    root.setInt('restlytics.self_ns.cache', selfCache);
    root.setInt('restlytics.self_ns.app', selfApp);
  }
}

/** Read a span's restlytics.category for self-time bucketing; default 'app'. */
function categoryOf(span: Span): 'db' | 'http' | 'cache' | 'app' {
  const cat = span.getString('restlytics.category');
  if (cat === 'db' || cat === 'http' || cat === 'cache' || cat === 'app') {
    return cat;
  }
  return 'app';
}

/**
 * Head-based trace-id-ratio sampling. Deterministic in the trace id so the
 * decision is stable and unbiased: hash the last 32 bits of the id into [0,1) and
 * keep it if it falls under the configured rate (SPEC §3).
 */
export function sampleDecision(traceIdHex: string, sampleRate: number): boolean {
  if (sampleRate >= 1.0) return true;
  if (sampleRate <= 0.0) return false;
  const tail = traceIdHex.slice(-8) || '0';
  const bucket = parseInt(tail, 16); // 0 .. 2^32-1
  const ratio = bucket / 0xffffffff;
  return ratio < sampleRate;
}

/**
 * The Tracer owns the transport + config and the AsyncLocalStorage that carries
 * the active RequestTrace. Instrumentation calls `current()` to find the request.
 */
export class Tracer {
  private readonly als = new AsyncLocalStorage<RequestTrace>();

  constructor(
    readonly config: ResolvedConfig,
    readonly transport: Transport,
  ) {}

  /** The active request trace, or undefined outside a traced request. */
  current(): RequestTrace | undefined {
    return this.als.getStore();
  }

  /** Run `fn` with a fresh RequestTrace bound to AsyncLocalStorage. */
  run<T>(trace: RequestTrace, fn: () => T): T {
    return this.als.run(trace, fn);
  }

  /**
   * Build a new RequestTrace, continuing an incoming W3C traceparent if present,
   * otherwise minting a fresh trace id. The sampling decision is HEAD-BASED and
   * made exactly once here (SPEC §3).
   */
  begin(traceparent: string | null | undefined): RequestTrace {
    const incoming = Ids.parseTraceparent(traceparent);
    let tid: string;
    let sampled: boolean;
    let parentSpanId: string | undefined;

    if (incoming) {
      tid = incoming.traceId;
      parentSpanId = incoming.parentSpanId;
      // Respect an upstream "not sampled" decision; only re-roll if it was sampled.
      sampled = incoming.sampled && sampleDecision(tid, this.config.sampleRate);
    } else {
      tid = Ids.traceId();
      parentSpanId = undefined;
      sampled = sampleDecision(tid, this.config.sampleRate);
    }

    const trace = new RequestTrace(this.config, tid, sampled);
    // Stash the root's parent (set once routing begins) so the caller can open
    // the root span with the right parentSpanId.
    pendingParent.set(trace, parentSpanId);
    return trace;
  }

  /** Open the root span for a trace begun by {@link begin}. */
  openRoot(trace: RequestTrace, name: string): Span | null {
    const parent = pendingParent.get(trace);
    pendingParent.delete(trace);
    return trace.openRoot(name, parent);
  }

  /** Helper used by status logic. */
  static get StatusCode() {
    return StatusCode;
  }
}

/**
 * Side table for the root parentSpanId between `begin()` and `openRoot()` so we
 * don't widen the RequestTrace public surface. A WeakMap means no leak if a trace
 * is dropped before openRoot.
 */
const pendingParent = new WeakMap<RequestTrace, string | undefined>();
