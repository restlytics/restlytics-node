import { randomBytes } from 'node:crypto';

/**
 * Trace / span id generation and W3C `traceparent` handling.
 *
 * OTLP/JSON wants lowercase-hex ids: 32 chars (16 bytes) for a trace id,
 * 16 chars (8 bytes) for a span id. The ingestion contract additionally rejects
 * all-zero ids, so we make sure the random bytes are never empty.
 */

const ALL_ZERO = /^0+$/;

/** 32 lowercase hex chars (16 random bytes), never all-zero. */
export function traceId(): string {
  return randomHex(16);
}

/** 16 lowercase hex chars (8 random bytes), never all-zero. */
export function spanId(): string {
  return randomHex(8);
}

function randomHex(bytes: number): string {
  // randomBytes is cryptographically secure. The all-zero probability is
  // negligible, but the contract forbids it, so guard.
  let hex = randomBytes(bytes).toString('hex');
  while (ALL_ZERO.test(hex)) {
    hex = randomBytes(bytes).toString('hex');
  }
  return hex;
}

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  /** low bit of the flags byte */
  sampled: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse a W3C `traceparent` header into { traceId, parentSpanId, sampled }.
 *
 * Format: `version-traceid-spanid-flags`, e.g.
 *   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 * Returns null when absent or malformed so the caller falls back to a fresh trace.
 * Continuing an incoming traceparent stitches a single distributed trace together
 * across services (e.g. an upstream gateway → this Node app).
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (header === null || header === undefined || header === '') {
    return null;
  }

  const m = TRACEPARENT_RE.exec(header.toLowerCase().trim());
  if (m === null) {
    return null;
  }

  const tid = m[2]!;
  const sid = m[3]!;
  const flags = m[4]!;

  // Reject the invalid all-zero trace/parent ids per the W3C spec.
  if (ALL_ZERO.test(tid) || ALL_ZERO.test(sid)) {
    return null;
  }

  return {
    traceId: tid,
    parentSpanId: sid,
    sampled: (parseInt(flags, 16) & 0x01) === 0x01,
  };
}

/** Build a W3C `traceparent` value for outbound injection (optional). */
export function formatTraceparent(traceIdHex: string, spanIdHex: string, sampled: boolean): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceIdHex}-${spanIdHex}-${flags}`;
}
