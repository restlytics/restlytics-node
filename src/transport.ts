import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gzip, gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import type { ExportLogsServiceRequest } from './logs.js';
import type { ExportTraceServiceRequest } from './otlp.js';

type TelemetryBatch =
  | { signal: 'traces'; payload: ExportTraceServiceRequest }
  | { signal: 'logs'; payload: ExportLogsServiceRequest };

/**
 * Ships a fully-built OTLP/JSON ExportTraceServiceRequest to the ingestion service.
 *
 * Implementations MUST be fire-and-forget and MUST NOT throw — telemetry must
 * never be able to fail (or slow) the host application's request (SPEC §6). Any
 * transport error is swallowed (and optionally reported), never surfaced.
 */
export interface Transport {
  send(payload: ExportTraceServiceRequest): void;
  /** Optional for compatibility with existing custom trace-only transports. */
  sendLogs?(payload: ExportLogsServiceRequest): void;
  flush?(timeoutMs?: number): Promise<boolean>;
  close?(timeoutMs?: number): Promise<boolean>;
  diagnostics?(): TransportDiagnostics;
}

/**
 * Provider-neutral custom telemetry destination.
 *
 * Exporters receive the same source-redacted OTLP/JSON objects as the built-in
 * HTTP transport. The SDK observes asynchronous results and isolates every
 * callback so exporter failures never reach the host application.
 */
export interface Exporter {
  exportTraces(payload: ExportTraceServiceRequest): void | Promise<void>;
  /** Optional so trace-only exporters remain valid when native logs are disabled. */
  exportLogs?(payload: ExportLogsServiceRequest): void | Promise<void>;
  flush?(timeoutMs?: number): void | boolean | Promise<void | boolean>;
  shutdown?(timeoutMs?: number): void | boolean | Promise<void | boolean>;
}

export interface TransportDiagnostics {
  readonly acceptedBatches: number;
  readonly deliveredBatches: number;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  readonly queuedBatches: number;
  readonly inFlightBatches: number;
  readonly queueCapacity: number;
  readonly closed: boolean;
}

export type ErrorReporter = (message: string, error?: unknown) => void;

/**
 * Failure-isolating adapter used for customer-supplied exporters.
 *
 * The adapter owns no credentials and never adds tenant identity to a payload.
 * It only forwards the already-built, already-redacted OTLP request object.
 */
export class ExporterTransport implements Transport {
  private readonly pending = new Set<Promise<void>>();
  private acceptedBatches = 0;
  private deliveredBatches = 0;
  private droppedBatches = 0;
  private failedBatches = 0;
  private isClosed = false;

  constructor(
    private readonly exporter: Exporter,
    private readonly onError?: ErrorReporter,
  ) {}

  send(payload: ExportTraceServiceRequest): void {
    this.exportBatch('traces', () => this.exporter.exportTraces(payload));
  }

  sendLogs(payload: ExportLogsServiceRequest): void {
    if (!this.exporter.exportLogs) {
      this.droppedBatches += 1;
      report(this.onError, 'restlytics: log batch dropped because the exporter does not support logs');
      return;
    }
    this.exportBatch('logs', () => this.exporter.exportLogs?.(payload));
  }

  diagnostics(): TransportDiagnostics {
    return {
      acceptedBatches: this.acceptedBatches,
      deliveredBatches: this.deliveredBatches,
      droppedBatches: this.droppedBatches,
      failedBatches: this.failedBatches,
      queuedBatches: 0,
      inFlightBatches: this.pending.size,
      queueCapacity: 0,
      closed: this.isClosed,
    };
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const exportsSettled = await this.settlePending(deadline);
    if (!exportsSettled) return false;
    return this.invokeLifecycle('flush', this.exporter.flush, deadline);
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    this.isClosed = true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const exportsSettled = await this.settlePending(deadline);
    const flushed = exportsSettled
      ? await this.invokeLifecycle('flush', this.exporter.flush, deadline)
      : false;
    const shutDown = await this.invokeLifecycle('shutdown', this.exporter.shutdown, deadline);
    return exportsSettled && flushed && shutDown;
  }

  private exportBatch(signal: TelemetryBatch['signal'], operation: () => void | Promise<void>): void {
    if (this.isClosed) {
      this.droppedBatches += 1;
      report(this.onError, `restlytics: ${signal} batch dropped because the exporter is closed`);
      return;
    }

    this.acceptedBatches += 1;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        let tracked: Promise<void>;
        tracked = Promise.resolve(result).then(
          () => {
            this.deliveredBatches += 1;
            this.pending.delete(tracked);
          },
          (error: unknown) => {
            this.failedBatches += 1;
            this.pending.delete(tracked);
            report(this.onError, `restlytics: custom ${signal} export failed`, error);
          },
        );
        this.pending.add(tracked);
      } else {
        this.deliveredBatches += 1;
      }
    } catch (error) {
      this.failedBatches += 1;
      report(this.onError, `restlytics: custom ${signal} export failed`, error);
    }
  }

  private async settlePending(deadline: number): Promise<boolean> {
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const settled = await bounded(Promise.allSettled([...this.pending]).then(() => true), remaining);
      if (!settled) return false;
    }
    return true;
  }

  private async invokeLifecycle(
    name: 'flush' | 'shutdown',
    operation: ((timeoutMs?: number) => void | boolean | Promise<void | boolean>) | undefined,
    deadline: number,
  ): Promise<boolean> {
    if (!operation) return true;
    const remaining = Math.max(0, deadline - Date.now());
    try {
      const outcome = await bounded(
        Promise.resolve(operation.call(this.exporter, remaining)).then((value) => value !== false),
        remaining,
      );
      if (outcome) return true;
      report(this.onError, `restlytics: custom exporter ${name} timed out or returned false`);
      return false;
    } catch (error) {
      report(this.onError, `restlytics: custom exporter ${name} failed`, error);
      return false;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<void>).then === 'function'
  );
}

async function bounded(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A local-only, structured description of a production-shaped trace batch. */
export interface TelemetryPreview {
  readonly mode: 'preview';
  readonly networkRequestMade: false;
  readonly signal: 'traces';
  readonly configuredSampleRate: number;
  readonly sampled: true;
  readonly spanCount: number;
  readonly jsonBytes: number;
  readonly gzipBytes: number;
  readonly redactionPolicyApplied: readonly string[];
  readonly payload: ExportTraceServiceRequest;
}

/** A local-only, structured description of a production-shaped log batch. */
export interface LogTelemetryPreview {
  readonly mode: 'preview';
  readonly networkRequestMade: false;
  readonly signal: 'logs';
  readonly logRecordCount: number;
  readonly jsonBytes: number;
  readonly gzipBytes: number;
  readonly redactionPolicyApplied: readonly string[];
  readonly payload: ExportLogsServiceRequest;
}

function report(onError: ErrorReporter | undefined, message: string, error?: unknown): void {
  if (!onError) return;
  try {
    onError(message, error);
  } catch {
    // Even reporting must not throw.
  }
}

/**
 * Default transport: gzip the JSON body and POST it to the OTLP signal path
 * with node's built-in http/https. Fire-and-forget — we don't await the response.
 *
 * Design constraints (all in service of "telemetry must never hurt the host app"):
 *  - Called AFTER the response `finish` event, so its latency is off the critical
 *    path of the user's request.
 *  - Hard short timeout (~2000ms) so a slow/unreachable ingest endpoint can't pile
 *    up sockets.
 *  - A fixed-size queue and one worker bound memory, gzip work, and open sockets.
 *  - Every error path is swallowed. We never throw into the host application.
 *
 * Wire format (must match the ingestion contract exactly, SPEC §2):
 *   POST {ingestUrl}/v1/traces
 *   X-Restlytics-Key: {key}
 *   Content-Type: application/json
 *   Content-Encoding: gzip
 *   body = gzip(json)
 */
export class HttpTransport implements Transport {
  private readonly queue: TelemetryBatch[] = [];
  private working = false;
  private isClosed = false;
  private acceptedBatches = 0;
  private deliveredBatches = 0;
  private droppedBatches = 0;
  private failedBatches = 0;

  constructor(
    private readonly ingestUrl: string,
    private readonly key: string,
    private readonly timeoutMs = 2000,
    private readonly onError?: ErrorReporter,
    private readonly queueCapacity = 64,
  ) {}

  send(payload: ExportTraceServiceRequest): void {
    this.enqueue({ signal: 'traces', payload });
  }

  sendLogs(payload: ExportLogsServiceRequest): void {
    this.enqueue({ signal: 'logs', payload });
  }

  private enqueue(batch: TelemetryBatch): void {
    // The request path only performs a bounded, non-blocking enqueue. JSON, gzip,
    // DNS and network I/O all run on the single background worker.
    if (this.isClosed || this.ingestUrl === '' || this.key === '') {
      this.recordDrop('restlytics: batch dropped because transport is closed or unconfigured');
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.recordDrop('restlytics: batch dropped because transport queue is full');
      return;
    }

    this.queue.push(batch);
    this.acceptedBatches += 1;
    this.startWorker();
  }

  diagnostics(): TransportDiagnostics {
    return {
      acceptedBatches: this.acceptedBatches,
      deliveredBatches: this.deliveredBatches,
      droppedBatches: this.droppedBatches,
      failedBatches: this.failedBatches,
      queuedBatches: this.queue.length,
      inFlightBatches: this.working ? 1 : 0,
      queueCapacity: this.queueCapacity,
      closed: this.isClosed,
    };
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.working || this.queue.length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return true;
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    this.isClosed = true;
    return this.flush(timeoutMs);
  }

  private startWorker(): void {
    if (this.working) return;
    this.working = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.shift();
        if (!batch) continue;
        try {
          const json = JSON.stringify(batch.payload);
          const body = await new Promise<Buffer>((resolve, reject) => {
            gzip(json, { level: 6 }, (error, encoded) =>
              error ? reject(error) : resolve(encoded),
            );
          });
          await this.post(body, batch.signal);
          this.deliveredBatches += 1;
        } catch (err) {
          this.failedBatches += 1;
          report(this.onError, 'restlytics: send failed', err);
        }
      }
    } finally {
      this.working = false;
      if (this.queue.length > 0) this.startWorker();
    }
  }

  private recordDrop(message: string): void {
    this.droppedBatches += 1;
    report(this.onError, message);
  }

  private post(body: Buffer, signal: TelemetryBatch['signal']): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.ingestUrl + (signal === 'logs' ? '/v1/logs' : '/v1/traces'));
        const isHttps = url.protocol === 'https:';
        const requestFn = isHttps ? httpsRequest : httpRequest;

        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };

        const req = requestFn(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              'Content-Length': body.length,
              'X-Restlytics-Key': this.key,
            },
          },
          (res) => {
            // Any HTTP response means the bounded delivery attempt completed. There
            // are deliberately no retries, especially not on the request path.
            res.on('error', finish);
            res.on('end', () => finish());
            res.resume();
          },
        );

        req.setTimeout(this.timeoutMs, () => {
          req.destroy(new Error('restlytics: send timed out'));
        });
        req.on('error', finish);

        req.end(body);
      } catch (err) {
        reject(err);
      }
    });
  }
}

/**
 * No-op transport. Useful in tests, local dev, and CI where you don't want to
 * (or can't) reach the ingestion service. Records payloads so tests can assert on
 * the built OTLP body without any network. Select with RESTLYTICS_TRANSPORT=null.
 */
export class NullTransport implements Transport {
  lastPayload: ExportTraceServiceRequest | null = null;
  readonly sent: ExportTraceServiceRequest[] = [];
  lastLogsPayload: ExportLogsServiceRequest | null = null;
  readonly sentLogs: ExportLogsServiceRequest[] = [];

  send(payload: ExportTraceServiceRequest): void {
    this.lastPayload = payload;
    this.sent.push(payload);
  }

  sendLogs(payload: ExportLogsServiceRequest): void {
    this.lastLogsPayload = payload;
    this.sentLogs.push(payload);
  }
}

/**
 * Writes the OTLP payload to a sink (default: console.log) instead of the network.
 * Handy for debugging the wire shape without standing up an ingestion service.
 * Select with RESTLYTICS_TRANSPORT=log.
 */
export class LogTransport implements Transport {
  constructor(private readonly writer: (json: string) => void = (j) => console.log(j)) {}

  send(payload: ExportTraceServiceRequest): void {
    this.write(payload);
  }

  sendLogs(payload: ExportLogsServiceRequest): void {
    this.write(payload);
  }

  private write(payload: ExportTraceServiceRequest | ExportLogsServiceRequest): void {
    try {
      this.writer(JSON.stringify(payload, null, 2));
    } catch {
      // Never throw into the host app, even for a dev transport.
    }
  }
}

/**
 * Emits a production-shaped preview report locally and never opens a socket.
 * Use `RESTLYTICS_TRANSPORT=preview` before connecting production traffic.
 */
export class PreviewTransport implements Transport {
  readonly reports: TelemetryPreview[] = [];
  readonly logReports: LogTelemetryPreview[] = [];

  constructor(
    private readonly sampleRate: number,
    private readonly writer: (json: string) => void = (json) => console.log(json),
  ) {}

  send(payload: ExportTraceServiceRequest): void {
    try {
      const encoded = JSON.stringify(payload);
      const report: TelemetryPreview = {
        mode: 'preview',
        networkRequestMade: false,
        signal: 'traces',
        configuredSampleRate: this.sampleRate,
        sampled: true,
        spanCount: payload.resourceSpans.reduce(
          (total, resource) =>
            total + resource.scopeSpans.reduce((count, scope) => count + scope.spans.length, 0),
          0,
        ),
        jsonBytes: Buffer.byteLength(encoded),
        gzipBytes: gzipSync(encoded, { level: 6 }).byteLength,
        redactionPolicyApplied: [
          'url query values and URL credentials',
          'sensitive headers and credentials',
          'request and response bodies',
          'exception messages and stack traces',
          'SQL binding values',
        ],
        payload,
      };
      this.reports.push(report);
      if (this.reports.length > 16) this.reports.shift();
      this.writer(JSON.stringify(report, null, 2));
    } catch {
      // Preview must retain the SDK's never-throw guarantee.
    }
  }

  sendLogs(payload: ExportLogsServiceRequest): void {
    try {
      const encoded = JSON.stringify(payload);
      const report: LogTelemetryPreview = {
        mode: 'preview',
        networkRequestMade: false,
        signal: 'logs',
        logRecordCount: payload.resourceLogs.reduce(
          (total, resource) =>
            total + resource.scopeLogs.reduce((count, scope) => count + scope.logRecords.length, 0),
          0,
        ),
        jsonBytes: Buffer.byteLength(encoded),
        gzipBytes: gzipSync(encoded, { level: 6 }).byteLength,
        redactionPolicyApplied: [
          'source-redacted message text',
          'sensitive structured attribute keys',
          'request and response bodies',
          'exception messages and stack traces',
          'SQL binding values',
        ],
        payload,
      };
      this.logReports.push(report);
      if (this.logReports.length > 16) this.logReports.shift();
      this.writer(JSON.stringify(report, null, 2));
    } catch {
      // Preview must retain the SDK's never-throw guarantee.
    }
  }
}
