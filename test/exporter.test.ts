import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  init,
  type Exporter,
  type ExportLogsServiceRequest,
  type ExportTraceServiceRequest,
} from '../dist/index.js';

test('custom exporter receives production OTLP traces and logs without credentials', async () => {
  const traces: ExportTraceServiceRequest[] = [];
  const logs: ExportLogsServiceRequest[] = [];
  const exporter: Exporter = {
    exportTraces: async (payload) => {
      await Promise.resolve();
      traces.push(payload);
    },
    exportLogs: async (payload) => {
      await Promise.resolve();
      logs.push(payload);
    },
  };
  const sdk = init({
    key: 'rl_customer_tenant_secret',
    serviceName: 'custom-exporter-test',
    logs: true,
    logsMinSeverity: 1,
    exporter,
  });

  await sdk.runJob({ name: 'orders.sync', system: 'custom', destination: 'orders' }, () => {
    sdk.log('warn', 'Bearer customer-log-secret', {
      authorization: 'customer-attribute-secret',
      component: 'orders',
    });
  });
  assert.equal(await sdk.flush(250), true);

  assert.equal(traces.length, 1);
  assert.equal(logs.length, 1);
  assert.ok(traces[0]?.resourceSpans.length);
  assert.ok(logs[0]?.resourceLogs.length);
  const exported = JSON.stringify({ traces, logs });
  assert.doesNotMatch(exported, /rl_customer_tenant_secret/);
  assert.doesNotMatch(exported, /customer-log-secret/);
  assert.doesNotMatch(exported, /customer-attribute-secret/);
  assert.match(exported, /custom-exporter-test/);
});

test('custom exporter callback and lifecycle failures never escape', async () => {
  const errors: string[] = [];
  const sdk = init({
    key: 'rl_test',
    logs: true,
    exporter: {
      exportTraces: () => {
        throw new Error('trace failed');
      },
      exportLogs: async () => {
        throw new Error('logs failed');
      },
      flush: () => {
        throw new Error('flush failed');
      },
      shutdown: async () => {
        throw new Error('shutdown failed');
      },
    },
    onError: (message) => errors.push(message),
  });

  await assert.doesNotReject(
    sdk.runJob(
      { name: 'safe.host.operation', system: 'custom', destination: 'safe' },
      () => sdk.log('error', 'x'),
    ),
  );
  assert.equal(await sdk.flush(250), false);
  assert.equal(await sdk.shutdown(250), false);
  assert.equal(sdk.diagnostics()?.failedBatches, 2);
  assert.ok(errors.some((message) => message.includes('custom traces export failed')));
  assert.ok(errors.some((message) => message.includes('custom logs export failed')));
  assert.ok(errors.some((message) => message.includes('custom exporter flush failed')));
  assert.ok(errors.some((message) => message.includes('custom exporter shutdown failed')));
});

test('custom exporter flush is bounded and trace-only exporters remain compatible', async () => {
  const errors: string[] = [];
  const sdk = init({
    key: 'rl_test',
    logs: true,
    exporter: {
      exportTraces: () => new Promise<void>(() => undefined),
    },
    onError: (message) => errors.push(message),
  });

  await sdk.runJob(
    { name: 'bounded.export', system: 'custom', destination: 'bounded' },
    () => sdk.log('warn', 'safe'),
  );
  const startedAt = Date.now();
  assert.equal(await sdk.flush(20), false);
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(sdk.diagnostics()?.droppedBatches, 1);
  assert.ok(errors.some((message) => message.includes('does not support logs')));
});

test('an error reporter that throws cannot break the host', async () => {
  const sdk = init({
    key: 'rl_test',
    exporter: {
      exportTraces: () => {
        throw new Error('export failed');
      },
    },
    onError: () => {
      throw new Error('reporter failed');
    },
  });

  await assert.doesNotReject(
    sdk.runJob(
      { name: 'safe.host.operation', system: 'custom', destination: 'safe' },
      () => undefined,
    ),
  );
});
