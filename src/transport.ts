import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gzip, gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import type { ExportTraceServiceRequest } from './otlp.js';

/**
 * Ships a fully-built OTLP/JSON ExportTraceServiceRequest to the ingestion service.
 *
 * Implementations MUST be fire-and-forget and MUST NOT throw — telemetry must
 * never be able to fail (or slow) the host application's request (SPEC §6). Any
 * transport error is swallowed (and optionally reported), never surfaced.
 */
export interface Transport {
  send(payload: ExportTraceServiceRequest): void;
  flush?(timeoutMs?: number): Promise<boolean>;
  close?(timeoutMs?: number): Promise<boolean>;
  diagnostics?(): TransportDiagnostics;
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

function report(onError: ErrorReporter | undefined, message: string, error?: unknown): void {
  if (!onError) return;
  try {
    onError(message, error);
  } catch {
    // Even reporting must not throw.
  }
}

/**
 * Default transport: gzip the JSON body and POST it to `{ingestUrl}/v1/traces`
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
  private readonly queue: ExportTraceServiceRequest[] = [];
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

    this.queue.push(payload);
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
        const payload = this.queue.shift();
        if (!payload) continue;
        try {
          const json = JSON.stringify(payload);
          const body = await new Promise<Buffer>((resolve, reject) => {
            gzip(json, { level: 6 }, (error, encoded) =>
              error ? reject(error) : resolve(encoded),
            );
          });
          await this.post(body);
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

  private post(body: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.ingestUrl + '/v1/traces');
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

  send(payload: ExportTraceServiceRequest): void {
    this.lastPayload = payload;
    this.sent.push(payload);
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
}
