import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
// The suite builds first; import the emitted package exactly as a consumer does.
import { HttpTransport, type ExportTraceServiceRequest } from '../dist/index.js';

const payload = {} as ExportTraceServiceRequest;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('send stays non-blocking, bounds its queue, reports drops, and flushes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_request, response) => {
    await gate;
    response.end();
  });
  const url = await listen(server);
  const errors: string[] = [];
  const transport = new HttpTransport(url, 'rl_test', 500, (message) => errors.push(message), 4);

  const started = performance.now();
  for (let i = 0; i < 10; i += 1) transport.send(payload);
  assert(performance.now() - started < 250, 'enqueue must not wait for network I/O');
  assert.equal(transport.diagnostics().acceptedBatches, 4);
  assert.equal(transport.diagnostics().droppedBatches, 6);
  assert.equal(transport.diagnostics().queueCapacity, 4);
  assert(errors.some((message) => message.includes('queue is full')));

  release();
  assert.equal(await transport.close(2_000), true);
  assert.equal(transport.diagnostics().deliveredBatches, 4);
  assert.equal(transport.diagnostics().queuedBatches, 0);
  transport.send(payload);
  assert.equal(transport.diagnostics().droppedBatches, 7);
  await stop(server);
});

test('timeout is counted, swallowed, and never retried', async () => {
  let attempts = 0;
  const server = createServer((_request, _response) => {
    attempts += 1;
  });
  const url = await listen(server);
  const transport = new HttpTransport(url, 'rl_test', 25);

  assert.doesNotThrow(() => transport.send(payload));
  assert.equal(await transport.flush(1_000), true);
  assert.equal(attempts, 1);
  assert.equal(transport.diagnostics().failedBatches, 1);
  assert.equal(transport.diagnostics().deliveredBatches, 0);
  await transport.close();
  await stop(server);
});
