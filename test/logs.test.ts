import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import {
  LogEmitter,
  NullTransport,
  SpanKind,
  Tracer,
  buildLogsPayload,
  buildPayload,
  captureWinstonLog,
  createPinoLogMethodHook,
  init,
  instrumentConsoleLogs,
  mapLogSeverity,
  resolveConfig,
  type ExportLogsServiceRequest,
  type ExportTraceServiceRequest,
  type Transport,
} from '../dist/index.js';

function records(transport: NullTransport) {
  return transport.sentLogs.flatMap((payload) =>
    payload.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('native logs are opt-in and default to WARN severity', () => {
  const defaults = resolveConfig({ transport: 'null' });
  assert.equal(defaults.logs, false);
  assert.equal(defaults.logsMinSeverity, 13);

  const disabledTransport = new NullTransport();
  const disabled = init({ transport: disabledTransport });
  assert.equal(disabled.log('error', 'disabled'), false);
  disabled.logger.flush();
  assert.equal(disabledTransport.sentLogs.length, 0);

  const transport = new NullTransport();
  const sdk = init({ logs: true, transport });
  assert.equal(sdk.log('info', 'below threshold'), false);
  assert.equal(sdk.log('warn', 'accepted'), true);
  sdk.logger.flush();
  assert.deepEqual(records(transport).map((record) => record.severityNumber), [13]);
});

test('RESTLYTICS_LOGS and RESTLYTICS_LOGS_MIN_SEVERITY resolve from env', () => {
  const previousLogs = process.env.RESTLYTICS_LOGS;
  const previousMinimum = process.env.RESTLYTICS_LOGS_MIN_SEVERITY;
  try {
    process.env.RESTLYTICS_LOGS = 'true';
    process.env.RESTLYTICS_LOGS_MIN_SEVERITY = '17';
    const config = resolveConfig();
    assert.equal(config.logs, true);
    assert.equal(config.logsMinSeverity, 17);
  } finally {
    if (previousLogs === undefined) delete process.env.RESTLYTICS_LOGS;
    else process.env.RESTLYTICS_LOGS = previousLogs;
    if (previousMinimum === undefined) delete process.env.RESTLYTICS_LOGS_MIN_SEVERITY;
    else process.env.RESTLYTICS_LOGS_MIN_SEVERITY = previousMinimum;
  }
});

test('severity mapping is exact and deterministic', () => {
  assert.deepEqual(mapLogSeverity('trace'), { severityNumber: 5, severityText: 'DEBUG' });
  assert.deepEqual(mapLogSeverity('debug'), { severityNumber: 5, severityText: 'DEBUG' });
  assert.deepEqual(mapLogSeverity('info'), { severityNumber: 9, severityText: 'INFO' });
  assert.deepEqual(mapLogSeverity('notice'), { severityNumber: 10, severityText: 'INFO2' });
  assert.deepEqual(mapLogSeverity('warning'), { severityNumber: 13, severityText: 'WARN' });
  assert.deepEqual(mapLogSeverity('error'), { severityNumber: 17, severityText: 'ERROR' });
  assert.deepEqual(mapLogSeverity('critical'), { severityNumber: 18, severityText: 'ERROR2' });
  assert.deepEqual(mapLogSeverity('alert'), { severityNumber: 21, severityText: 'FATAL' });
  assert.deepEqual(mapLogSeverity('emergency'), { severityNumber: 21, severityText: 'FATAL' });
  assert.deepEqual(mapLogSeverity('fatal'), { severityNumber: 21, severityText: 'FATAL' });
  assert.deepEqual(mapLogSeverity('custom'), { severityNumber: 9, severityText: 'INFO' });
  assert.deepEqual(mapLogSeverity(24), { severityNumber: 24, severityText: 'FATAL' });
});

test('logs stamp active sampled and unsampled trace context and omit ids outside it', () => {
  const sampledTransport = new NullTransport();
  const sampled = init({ logs: true, sampleRate: 1, transport: sampledTransport });
  const trace = sampled.tracer.begin(undefined);
  const root = sampled.tracer.openRoot(trace, 'GET /orders', { kind: SpanKind.SERVER });
  assert(root);
  sampled.tracer.run(trace, () => sampled.log('error', 'inside sampled trace'));
  sampled.logger.flush();
  assert.equal(records(sampledTransport)[0]?.traceId, trace.traceId);
  assert.equal(records(sampledTransport)[0]?.spanId, root.spanId);
  assert.equal(records(sampledTransport)[0]?.flags, 1);

  const unsampledTransport = new NullTransport();
  const unsampled = init({ logs: true, sampleRate: 0, transport: unsampledTransport });
  const droppedTrace = unsampled.tracer.begin(undefined);
  assert.equal(unsampled.tracer.openRoot(droppedTrace, 'GET /quiet'), null);
  unsampled.tracer.run(droppedTrace, () => unsampled.log('error', 'inside unsampled trace'));
  unsampled.logger.flush();
  assert.equal(records(unsampledTransport)[0]?.traceId, droppedTrace.traceId);
  assert.match(records(unsampledTransport)[0]?.spanId ?? '', /^[0-9a-f]{16}$/);
  assert.equal(records(unsampledTransport)[0]?.flags, 0);

  const outsideTransport = new NullTransport();
  const outside = init({ logs: true, transport: outsideTransport });
  outside.log('error', 'outside trace');
  outside.logger.flush();
  assert.equal(records(outsideTransport)[0]?.traceId, undefined);
  assert.equal(records(outsideTransport)[0]?.spanId, undefined);
  assert.equal(records(outsideTransport)[0]?.flags, undefined);
});

test('log payload shares trace resource identity and redacts source canaries', () => {
  const transport = new NullTransport();
  const sdk = init({
    logs: true,
    transport,
    serviceName: 'checkout',
    env: 'test',
  });
  const secret = 'customer-secret-must-not-leave';
  sdk.log(
    'error',
    `login alice@example.test password=hunter2 Authorization: Bearer abc.def.ghi ` +
      `https://api.test/users/123?token=${secret} request_body=${secret} ` +
      `response_body=${secret} bindings=[${secret}] exception=${secret} ` +
      `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    {
      component: 'checkout',
      endpoint: `https://api.test/pay?api_key=${secret}`,
      password: secret,
      'http.request.header.cookie': `session=${secret}`,
      'express.request.body': secret,
      bindings: secret,
      exception: new Error(secret),
      nested: { secret },
      'source.file.path': `/Users/${secret}/checkout.ts`,
    },
  );
  sdk.logger.flush();

  const payload = transport.sentLogs[0]!;
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /alice@example\.test|hunter2|abc\.def\.ghi/);
  assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /http\.request\.header\.cookie|express\.request\.body/);
  assert.match(serialized, /\[REDACTED\]/);
  const attrs = records(transport)[0]?.attributes ?? [];
  assert.deepEqual(attrs.map((item) => item.key), ['component', 'endpoint', 'source.file.path']);
  assert.deepEqual(attrs[2]?.value, { stringValue: 'checkout.ts' });

  const tracePayload = buildPayload('checkout', 'test', []);
  const logsPayload = buildLogsPayload('checkout', 'test', []);
  assert.deepEqual(
    logsPayload.resourceLogs[0]?.resource,
    tracePayload.resourceSpans[0]?.resource,
  );
});

test('log buffering is capped, observable, and explicitly flushable', () => {
  const config = resolveConfig({ logs: true, transport: 'null' });
  const transport = new NullTransport();
  const tracer = new Tracer(config, transport);
  const errors: string[] = [];
  config.onError = (message) => errors.push(message);
  const logger = new LogEmitter(config, tracer, transport, {
    maxBufferedRecords: 2,
    batchSize: 10,
    flushIntervalMs: 60_000,
  });

  assert.equal(logger.record('warn', 'one'), true);
  assert.equal(logger.record('warn', 'two'), true);
  assert.equal(logger.record('warn', 'three'), false);
  assert.equal(logger.diagnostics().bufferedRecords, 2);
  assert.equal(logger.diagnostics().droppedRecords, 1);
  assert(errors.some((message) => message.includes('buffer is full')));
  logger.flush();
  assert.equal(records(transport).length, 2);
  assert.equal(logger.diagnostics().bufferedRecords, 0);
});

test('background-work completion flushes correlated logs without an explicit SDK flush', async () => {
  const transport = new NullTransport();
  const sdk = init({ logs: true, transport });
  await sdk.runJob(
    { name: 'orders.reconcile', system: 'redis', destination: 'orders' },
    () => {
      sdk.log('warn', 'retry scheduled', { component: 'orders' });
    },
  );

  assert.equal(transport.sentLogs.length, 1);
  assert.match(records(transport)[0]?.traceId ?? '', /^[0-9a-f]{32}$/);
  assert.match(records(transport)[0]?.spanId ?? '', /^[0-9a-f]{16}$/);
});

test('capture and transport failures never impact the host application', async () => {
  const failures: string[] = [];
  const throwing: Transport = {
    send: () => undefined,
    sendLogs: () => {
      throw new Error('transport exploded');
    },
    flush: async () => true,
  };
  const sdk = init({ logs: true, transport: throwing, onError: (message) => failures.push(message) });
  assert.doesNotThrow(() => sdk.log('error', 'customer operation succeeded'));
  assert.equal(await sdk.flush(), true);
  assert.equal(sdk.logger.diagnostics().droppedRecords, 1);
  assert(failures.some((message) => message.includes('log export failed')));
});

test('HTTP transport gzip-posts logs to /v1/logs and treats error responses as non-impacting', async () => {
  const captures: Array<{
    path: string | undefined;
    key: string | undefined;
    encoding: string | undefined;
    payload: ExportLogsServiceRequest;
  }> = [];
  let status = 202;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captures.push({
        path: request.url,
        key: request.headers['x-restlytics-key'] as string | undefined,
        encoding: request.headers['content-encoding'],
        payload: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) as ExportLogsServiceRequest,
      });
      response.writeHead(status);
      response.end();
    });
  });
  const ingestUrl = await listen(server);
  const sdk = init({ logs: true, key: 'rl_logs_test', ingestUrl, timeoutMs: 300 });

  try {
    sdk.log('error', 'first');
    assert.equal(await sdk.flush(2_000), true);
    assert.equal(captures[0]?.path, '/v1/logs');
    assert.equal(captures[0]?.key, 'rl_logs_test');
    assert.equal(captures[0]?.encoding, 'gzip');
    assert.equal(captures[0]?.payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body?.stringValue, 'first');

    status = 503;
    assert.doesNotThrow(() => sdk.log('fatal', 'ingest unavailable'));
    assert.equal(await sdk.flush(2_000), true);
    assert.equal(captures.length, 2);
  } finally {
    await sdk.shutdown();
    await stop(server);
  }
});

test('console, Pino, and Winston-friendly hooks preserve logger behaviour', () => {
  const transport = new NullTransport();
  const sdk = init({ logs: true, logsMinSeverity: 5, transport });
  const consoleOutput: unknown[][] = [];
  const target = {
    debug: (...args: unknown[]) => consoleOutput.push(args),
    info: (...args: unknown[]) => consoleOutput.push(args),
    log: (...args: unknown[]) => consoleOutput.push(args),
    warn: (...args: unknown[]) => consoleOutput.push(args),
    error: (...args: unknown[]) => consoleOutput.push(args),
  };
  const restore = instrumentConsoleLogs(sdk, target);
  target.warn('console warning');
  restore();
  target.warn('not captured after restore');
  assert.deepEqual(consoleOutput, [['console warning'], ['not captured after restore']]);

  const forwarded: unknown[][] = [];
  const pinoHook = createPinoLogMethodHook(sdk);
  const receiver = { marker: true };
  const result = pinoHook.call(
    receiver,
    [{ component: 'api' }, 'pino failure'],
    function (this: unknown, ...args: unknown[]) {
      assert.equal(this, receiver);
      forwarded.push(args);
      return 'forwarded';
    },
    50,
  );
  assert.equal(result, 'forwarded');
  assert.deepEqual(forwarded, [[{ component: 'api' }, 'pino failure']]);

  captureWinstonLog(sdk, { level: 'critical', message: 'winston failure', component: 'worker' });
  sdk.logger.flush();
  assert.deepEqual(
    records(transport).map((record) => record.severityNumber),
    [13, 17, 18],
  );
});

// Compile-time guard: the two signal payloads remain distinct public contracts.
void ({} as ExportTraceServiceRequest);
