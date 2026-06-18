import * as diagnosticsChannel from 'node:diagnostics_channel';
import { SpanKind } from '../otlp.js';
import { redactUrl } from '../redact.js';
import type { Tracer } from '../tracer.js';

/**
 * Optional outbound-HTTP instrumentation (SPEC §8: best-effort). Records an HTTP
 * CLIENT span (`restlytics.category="http"`) for each outbound call, with the
 * query string of `url.full` REDACTED. This is best-effort: if the diagnostics
 * channel isn't available, instrumentation is silently skipped.
 *
 * Implemented via the built-in `undici`/`fetch` diagnostics channels
 * (`undici:request:create` / `undici:request:headers`), which cover global
 * `fetch()` on Node 18+ and the `undici` package. No monkey-patching of `http`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function instrumentHttp(tracer: Tracer): () => void {
  if (!tracer.config.instruments.http) return () => {};

  const dc = diagnosticsChannel;

  // Map the in-flight request object → its span start time (monotonic).
  const starts = new WeakMap<object, { startNs: bigint; method: string; url: string }>();

  const onCreate = (message: any) => {
    try {
      const trace = tracer.current();
      if (!trace || !trace.sampled || trace.rootSpan === null) return;
      const req = message?.request;
      if (!req) return;
      const method: string = (req.method ?? 'GET').toUpperCase();
      const origin: string = req.origin ?? '';
      const path: string = req.path ?? '';
      const full = `${origin}${path}`;
      starts.set(req, { startNs: trace.nowNs(), method, url: full });
    } catch {
      // best-effort
    }
  };

  const finish = (message: any, errored: boolean) => {
    try {
      const trace = tracer.current();
      if (!trace || !trace.sampled || trace.rootSpan === null) return;
      const req = message?.request;
      const meta = req ? starts.get(req) : undefined;
      if (!meta) return;
      starts.delete(req);

      const endNs = trace.nowNs();
      let host = '';
      try {
        host = new URL(meta.url).host;
      } catch {
        host = '';
      }

      const span = trace.addChild(`${meta.method} ${host || 'http'}`, 'http', meta.startNs, endNs, SpanKind.CLIENT);
      if (span === null) return;
      span.setString('http.request.method', meta.method);
      span.setString('url.full', redactUrl(meta.url, tracer.config.redaction.queryKeys));
      if (host) span.setString('server.address', host);

      const status: number | undefined = message?.response?.statusCode;
      if (typeof status === 'number') {
        span.setInt('http.response.status_code', status);
        if (status >= 500) span.setStatus(2, `HTTP ${status}`);
      }
      if (errored) span.setStatus(2, 'request error');
    } catch {
      // best-effort
    }
  };

  const onHeaders = (message: any) => finish(message, false);
  const onError = (message: any) => finish(message, true);

  try {
    dc.subscribe('undici:request:create', onCreate);
    dc.subscribe('undici:request:headers', onHeaders);
    dc.subscribe('undici:request:error', onError);
  } catch (err) {
    tracer.config.onError?.('restlytics: failed to subscribe undici channels', err);
    return () => {};
  }

  return function uninstrument() {
    try {
      dc.unsubscribe('undici:request:create', onCreate);
      dc.unsubscribe('undici:request:headers', onHeaders);
      dc.unsubscribe('undici:request:error', onError);
    } catch {
      // ignore
    }
  };
}
