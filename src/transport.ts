import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gzip } from 'node:zlib';
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
}

export type ErrorReporter = (message: string, error?: unknown) => void;

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
  constructor(
    private readonly ingestUrl: string,
    private readonly key: string,
    private readonly timeoutMs = 2000,
    private readonly onError?: ErrorReporter,
  ) {}

  send(payload: ExportTraceServiceRequest): void {
    // Defensive: without the basics, there's nothing useful to do — and we must
    // not throw, so just bail quietly.
    if (this.ingestUrl === '' || this.key === '') {
      return;
    }

    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch (err) {
      report(this.onError, 'restlytics: failed to encode payload', err);
      return;
    }

    gzip(json, { level: 6 }, (gzErr, body) => {
      if (gzErr) {
        // gzip is required by the contract's Content-Encoding header; if it fails,
        // drop the batch rather than send a mislabeled body.
        report(this.onError, 'restlytics: gzip failed', gzErr);
        return;
      }
      this.post(body);
    });
  }

  private post(body: Buffer): void {
    try {
      const url = new URL(this.ingestUrl + '/v1/traces');
      const isHttps = url.protocol === 'https:';
      const requestFn = isHttps ? httpsRequest : httpRequest;

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
          // Response is always treated as success; drain and discard so the socket
          // can be freed. We never retry into the request path (SPEC §6).
          res.on('error', () => {});
          res.resume();
        },
      );

      req.setTimeout(this.timeoutMs, () => {
        // Degrade silently on a slow/black-holed host.
        req.destroy();
      });
      req.on('error', (err) => {
        report(this.onError, 'restlytics: send failed', err);
      });

      req.end(body);
    } catch (err) {
      // Absolute backstop — nothing here may ever propagate.
      report(this.onError, 'restlytics: transport exception', err);
    }
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
