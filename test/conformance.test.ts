import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseTraceparent } from '../dist/ids.js';
import {
  buildPayload,
  SDK_LANGUAGE,
  SDK_NAME,
  SDK_VERSION,
  Span,
} from '../dist/otlp.js';
import { sampleDecision } from '../dist/tracer.js';

function properties(): Record<string, string> {
  const text = readFileSync(new URL('./fixtures/v1/vectors.properties', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test('matches the shared OTLP, propagation, redaction, error, and sampling fixture', () => {
  const fixture = properties();
  const span = new Span({
    traceId: fixture['trace.id']!,
    spanId: fixture['span.id']!,
    parentSpanId: fixture['span.parent_id']!,
    name: fixture['span.name']!,
    kind: Number(fixture['span.kind']),
    startUnixNano: BigInt(fixture['span.start_ns']!),
    endUnixNano: BigInt(fixture['span.end_ns']!),
  });
  span
    .setString(fixture['attribute.string.key']!, fixture['attribute.string.value']!)
    .setInt(fixture['attribute.int.key']!, Number(fixture['attribute.int.value']))
    .setBool(fixture['attribute.bool.key']!, fixture['attribute.bool.value'] === 'true')
    .setString(fixture['redaction.attribute_key']!, fixture['redaction.attribute_value']!)
    .setStatus(Number(fixture['error.status_code']) as 2, fixture['error.message']);

  const expected = readFileSync(
    new URL('./fixtures/v1/otlp.expected.json', import.meta.url),
    'utf8',
  )
    .replaceAll('${SDK_NAME}', SDK_NAME)
    .replaceAll('${SDK_LANGUAGE}', SDK_LANGUAGE)
    .replaceAll('${SDK_VERSION}', SDK_VERSION);
  assert.deepEqual(
    buildPayload(fixture['service.name']!, fixture['deployment.environment']!, [span]),
    JSON.parse(expected),
  );

  assert.deepEqual(parseTraceparent(fixture['propagation.sampled']!), {
    traceId: fixture['trace.id'],
    parentSpanId: fixture['span.id'],
    sampled: true,
  });
  assert.equal(parseTraceparent(fixture['propagation.unsampled']!)?.sampled, false);
  assert.equal(parseTraceparent(fixture['propagation.invalid']!), null);
  assert.equal(
    sampleDecision(fixture['trace.id']!, Number(fixture['sampling.root_rate_zero'])),
    false,
  );
  assert.equal(
    sampleDecision(fixture['trace.id']!, Number(fixture['sampling.root_rate_one'])),
    true,
  );
});
