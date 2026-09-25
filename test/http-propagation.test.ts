import assert from 'node:assert/strict';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import test from 'node:test';
import {
  init,
  instrumentOutboundHttp,
  type ExportTraceServiceRequest,
  type Transport,
} from '../dist/index.js';

class CaptureTransport implements Transport {
  payloads: ExportTraceServiceRequest[] = [];

  send(payload: ExportTraceServiceRequest): void {
    this.payloads.push(payload);
  }
}

function fakeRequest() {
  return {
    method: 'GET',
    origin: 'https://api.example.test',
    path: '/orders?token=secret',
    headers: ['traceparent', '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00'],
    addHeader(name: string, value: string) {
      this.headers.push(name, value);
    },
  };
}

test('outbound HTTP injects the CLIENT span traceparent and records that exact span id', () => {
  const transport = new CaptureTransport();
  const sdk = init({ key: 'rk_test', serviceName: 'node-test', env: 'test', transport });
  const uninstrument = instrumentOutboundHttp(sdk);
  const trace = sdk.tracer.begin(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  );
  sdk.tracer.openRoot(trace, 'GET /proxy');
  const request = fakeRequest();

  try {
    sdk.tracer.run(trace, () => {
      diagnosticsChannel.channel('undici:request:create').publish({ request });
      diagnosticsChannel.channel('undici:request:headers').publish({
        request,
        response: { statusCode: 200 },
      });
      trace.finish(transport);
    });
  } finally {
    uninstrument();
  }

  const header = request.headers[1]!;
  assert.match(header, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  const spans = transport.payloads[0]!.resourceSpans[0]!.scopeSpans[0]!.spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[1]!.spanId, header.split('-')[2]);
  assert.equal(spans[1]!.parentSpanId, spans[0]!.spanId);
});

test('unsampled outbound HTTP still propagates flags=00 without recording a span', () => {
  const transport = new CaptureTransport();
  const sdk = init({ key: 'rk_test', serviceName: 'node-test', env: 'test', transport });
  const uninstrument = instrumentOutboundHttp(sdk);
  const trace = sdk.tracer.begin(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
  );
  sdk.tracer.openRoot(trace, 'GET /proxy');
  const request = fakeRequest();

  try {
    sdk.tracer.run(trace, () => {
      diagnosticsChannel.channel('undici:request:create').publish({ request });
      diagnosticsChannel.channel('undici:request:headers').publish({
        request,
        response: { statusCode: 200 },
      });
      trace.finish(transport);
    });
  } finally {
    uninstrument();
  }

  assert.match(
    request.headers[1]!,
    /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-00$/,
  );
  assert.equal(transport.payloads.length, 0);
});

test('a response reported outside the request context still completes its CLIENT span', () => {
  const transport = new CaptureTransport();
  const sdk = init({ key: 'rk_test', serviceName: 'node-test', env: 'test', transport });
  const uninstrument = instrumentOutboundHttp(sdk);
  const trace = sdk.tracer.begin(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  );
  sdk.tracer.openRoot(trace, 'GET /proxy');
  const request = fakeRequest();

  try {
    sdk.tracer.run(trace, () => {
      diagnosticsChannel.channel('undici:request:create').publish({ request });
    });
    // undici emits response events from the pooled socket's async context,
    // which may have been opened outside this (or any) traced request.
    diagnosticsChannel.channel('undici:request:headers').publish({
      request,
      response: { statusCode: 503 },
    });
    trace.finish(transport);
  } finally {
    uninstrument();
  }

  const client = transport.payloads[0]!.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
  const status = client.attributes?.find(
    (attribute) => attribute.key === 'http.response.status_code',
  );
  assert.equal(client.spanId, request.headers[1]!.split('-')[2]);
  assert.deepEqual(status?.value, { intValue: '503' });
  assert.equal(client.status?.code, 2);
  assert.ok(BigInt(client.endTimeUnixNano) >= BigInt(client.startTimeUnixNano));
});
