import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import express from 'express';
// The suite builds first; import the emitted package exactly as a consumer does.
import { expressMiddleware, init, type ExportTraceServiceRequest } from '../dist/index.js';

const PROJECT_KEY = 'rk_project_alpha';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const SECRET = 'customer-secret-must-not-leave-the-app';

interface Capture {
  key: string | undefined;
  path: string | undefined;
  payload: ExportTraceServiceRequest;
}

function root(payload: ExportTraceServiceRequest) {
  return payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
}

function attributes(payload: ExportTraceServiceRequest) {
  return Object.fromEntries(root(payload).attributes?.map((item) => [item.key, item.value]) ?? []);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('a real Express app emits tenant-safe OTLP and survives ingest failure', async () => {
  const captures: Capture[] = [];
  const waiters: Array<() => void> = [];
  let ingestStatus = 202;
  const ingest = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = gunzipSync(Buffer.concat(chunks));
      captures.push({
        key: req.headers['x-restlytics-key'] as string | undefined,
        path: req.url,
        payload: JSON.parse(body.toString('utf8')) as ExportTraceServiceRequest,
      });
      waiters.shift()?.();
      res.writeHead(ingestStatus, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const ingestPort = await listen(ingest);

  const sdk = init({
    key: PROJECT_KEY,
    ingestUrl: `http://127.0.0.1:${ingestPort}`,
    serviceName: 'express-beta-app',
    env: 'test',
    timeoutMs: 300,
  });
  const app = express();
  app.use(expressMiddleware(sdk));
  app.get('/orders/:id', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/fail/:id', (_req, res) => res.status(503).json({ ok: false }));
  const customer = app.listen(0, '127.0.0.1');
  await once(customer, 'listening');
  const customerAddress = customer.address();
  assert(customerAddress && typeof customerAddress === 'object');

  const awaitCapture = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for ingest')), 2_000);
    waiters.push(() => {
      clearTimeout(timeout);
      resolve();
    });
  });

  try {
    const firstCapture = awaitCapture();
    const response = await fetch(
      `http://127.0.0.1:${customerAddress.port}/orders/42?token=${SECRET}`,
      {
        headers: {
          authorization: `Bearer ${SECRET}`,
          cookie: `session=${SECRET}`,
          traceparent: TRACEPARENT,
        },
      },
    );
    assert.equal(response.status, 200);
    await firstCapture;

    assert.equal(captures[0]!.path, '/v1/traces');
    assert.equal(captures[0]!.key, PROJECT_KEY);
    assert.equal(root(captures[0]!.payload).traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(root(captures[0]!.payload).parentSpanId, '00f067aa0ba902b7');
    assert.deepEqual(attributes(captures[0]!.payload)['http.route'], { stringValue: '/orders/:id' });
    assert.equal(JSON.stringify(captures[0]!.payload).includes(PROJECT_KEY), false);
    assert.equal(JSON.stringify(captures[0]!.payload).includes(SECRET), false);

    ingestStatus = 503;
    const failedCapture = awaitCapture();
    const unaffected = await fetch(`http://127.0.0.1:${customerAddress.port}/orders/43`);
    assert.equal(unaffected.status, 200, 'ingest failure must not fail the customer request');
    await failedCapture;

    ingestStatus = 202;
    const errorCapture = awaitCapture();
    const failedRoute = await fetch(`http://127.0.0.1:${customerAddress.port}/fail/44`);
    assert.equal(failedRoute.status, 503);
    await errorCapture;
    assert.equal(root(captures[2]!.payload).status?.code, 2);
    assert.deepEqual(attributes(captures[2]!.payload)['http.route'], { stringValue: '/fail/:id' });
  } finally {
    await close(customer);
    await close(ingest);
  }
});
