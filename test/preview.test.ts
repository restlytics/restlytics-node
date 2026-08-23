import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PreviewTransport,
  Span,
  SpanKind,
  buildPayload,
  init,
  resolveConfig,
} from '../dist/index.js';

test('preview mode reports redacted production payload size without networking', () => {
  const output: string[] = [];
  const transport = new PreviewTransport(0.25, (json) => output.push(json));
  const span = new Span({
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    name: 'GET /users/{id}',
    kind: SpanKind.SERVER,
    startUnixNano: 1n,
    endUnixNano: 2n,
  });
  span.setString('url.full', 'https://user:secret@example.com/users/1?token=secret');
  span.setString('http.request.body', 'do-not-export');
  transport.send(buildPayload('preview-app', 'production', [span]));

  assert.equal(transport.reports.length, 1);
  const report = transport.reports[0];
  assert.equal(report.networkRequestMade, false);
  assert.equal(report.configuredSampleRate, 0.25);
  assert.equal(report.spanCount, 1);
  assert.ok(report.jsonBytes > report.gzipBytes);
  assert.doesNotMatch(output[0], /secret|do-not-export/);
  assert.match(output[0], /REDACTED/);
});

test('preview transport works without an ingest key', () => {
  const sdk = init({ transport: 'preview', sampleRate: 1 });
  assert.equal(sdk.transport instanceof PreviewTransport, true);
  assert.equal(resolveConfig({ transport: 'preview' }).transport, 'preview');
});
