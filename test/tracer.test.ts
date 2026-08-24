import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported from dist, not src: node's type stripper can't load the multi-file
// source graph (it doesn't resolve `./x.js` specifiers to `./x.ts`, and it can't
// strip constructor parameter properties). `npm test` builds first.
import { Tracer } from '../dist/tracer.js';
import { resolveConfig } from '../dist/config.js';
import { NullTransport } from '../dist/transport.js';

// sampleRate 0.0 means any local head-based roll comes back false — so a
// continued trace that stays sampled can only have inherited the upstream bit.
const neverSamples = () =>
  new Tracer(
    resolveConfig({ key: 'rk_test', sampleRate: 0.0, transport: 'null' }),
    new NullTransport(),
  );

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const traceparent = (flags: string) => `00-${TRACE_ID}-${PARENT_SPAN_ID}-${flags}`;

test('a continued trace inherits an upstream "sampled" bit instead of re-rolling', () => {
  const trace = neverSamples().begin(traceparent('01'));
  assert.equal(trace.sampled, true);
  assert.equal(trace.traceId, TRACE_ID);
});

test('a continued trace inherits an upstream "not sampled" bit', () => {
  const trace = neverSamples().begin(traceparent('00'));
  assert.equal(trace.sampled, false);
});

test('a root trace (no traceparent) still makes its own head-based decision', () => {
  const trace = neverSamples().begin(null);
  assert.equal(trace.sampled, false);
});
