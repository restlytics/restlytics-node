import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, PreviewTransport, SpanKind } from '../dist/index.js';

function previewSdk() {
  const transport = new PreviewTransport(1, () => undefined);
  return { sdk: init({ key: 'rk_test', transport }), transport };
}

test('records a successful job with stable queue metadata and queue propagation', async () => {
  const { sdk, transport } = previewSdk();
  const carrier: Record<string, unknown> = { customer: 'not-exported' };
  await sdk.runJob(
    { name: 'billing.reconcile', system: 'redis', destination: 'billing', attempt: 2 },
    async () => {
      await sdk.runEnqueue({ system: 'redis', destination: 'emails' }, carrier, async () => undefined);
    },
  );

  const payload = transport.reports[0]?.payload as any;
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const root = spans[0];
  const enqueue = spans[1];
  assert.equal(root.kind, SpanKind.CONSUMER);
  assert.equal(root.name, 'billing.reconcile');
  assert.equal(root.status.code, 1);
  assert.equal(root.attributes.find((a: any) => a.key === 'restlytics.job.attempt').value.intValue, '2');
  assert.equal(root.attributes.find((a: any) => a.key === 'restlytics.self_ns.queue').value.intValue >= '0', true);
  assert.equal(enqueue.attributes.find((a: any) => a.key === 'restlytics.category').value.stringValue, 'queue');
  assert.match((carrier.__restlytics as any).traceparent, new RegExp(`-${enqueue.spanId}-01$`));
  assert.doesNotMatch(JSON.stringify(payload), /not-exported/);
});

test('continues queue context, records a link, and captures failure without exception content', async () => {
  const { sdk, transport } = previewSdk();
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  await assert.rejects(
    sdk.runJob(
      { name: 'send.email', system: 'redis', destination: 'emails', traceparent },
      async () => {
        throw new Error('customer secret');
      },
    ),
  );

  const root = (transport.reports[0]?.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(root.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(root.parentSpanId, '00f067aa0ba902b7');
  assert.equal(root.links[0].attributes[0].value.stringValue, 'enqueue');
  assert.deepEqual(root.status, { code: 2 });
  assert.doesNotMatch(JSON.stringify(root), /customer secret/);
});

test('isolates concurrent scheduled tasks and records command exit failures', async () => {
  const { sdk, transport } = previewSdk();
  await Promise.all([
    sdk.runSchedule({ name: 'nightly-digest', cron: '0 3 * * *' }, async () => undefined),
    sdk.runCommand({ name: 'reports:generate' }, async () => 2),
  ]);

  const roots = transport.reports.map(
    (report: any) => report.payload.resourceSpans[0].scopeSpans[0].spans[0],
  );
  assert.equal(new Set(roots.map((root: any) => root.traceId)).size, 2);
  assert.equal(roots.find((root: any) => root.name === 'nightly-digest').status.code, 1);
  assert.equal(roots.find((root: any) => root.name === 'reports:generate').status.code, 2);
});

test('propagates an unsampled queue context without exporting telemetry', async () => {
  const transport = new PreviewTransport(0, () => undefined);
  const sdk = init({ key: 'rk_test', sampleRate: 0, transport });
  const carrier: Record<string, unknown> = {};

  await sdk.runJob(
    { name: 'billing.reconcile', system: 'redis', destination: 'billing' },
    () => sdk.runEnqueue({ system: 'redis', destination: 'emails' }, carrier, async () => undefined),
  );

  assert.match((carrier.__restlytics as any).traceparent, /-00$/);
  assert.equal(transport.reports.length, 0);
});
