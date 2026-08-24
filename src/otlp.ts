/**
 * OTLP/JSON wire format (subset) and the in-request `Span` accumulator.
 *
 * This matches `packages/contract/src/otlp.ts` exactly. The three classic
 * footguns (SPEC §2) are enforced here:
 *  - trace/span ids are lowercase hex of the right length, never all-zero
 *    (handled in ids.ts);
 *  - every `*UnixNano` field is a decimal STRING (int64-safe in JSON);
 *  - `intValue` is a STRING, not a JSON number.
 *
 * Timestamps are kept as `bigint` nanoseconds internally and only stringified at
 * serialization time. Attribute values are kept as raw scalars and converted to
 * the OTLP AnyValue wrapper at serialization.
 */

import {
  isSensitiveAttributeKey,
  redactExceptionMessage,
  redactUrl,
} from "./redact.js";

// ---------------------------------------------------------------------------
// Wire types (structurally identical to packages/contract)
// ---------------------------------------------------------------------------

export interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  /** int64 as a (signed) decimal string */
  intValue?: string;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values: AnyValue[] };
  kvlistValue?: { values: KeyValue[] };
}

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface SpanStatus {
  code: 0 | 1 | 2;
  message?: string;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: KeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  links?: SpanLink[];
  status?: SpanStatus;
}

export interface InstrumentationScope {
  name?: string;
  version?: string;
}

export interface ScopeSpans {
  scope?: InstrumentationScope;
  spans: OtlpSpan[];
}

export interface Resource {
  attributes?: KeyValue[];
}

export interface ResourceSpans {
  resource?: Resource;
  scopeSpans: ScopeSpans[];
}

/** Top-level OTLP traces export request — the body of `POST /v1/traces`. */
export interface ExportTraceServiceRequest {
  resourceSpans: ResourceSpans[];
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export const StatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/** restlytics span category — drives the db/http/cache/app breakdown (SPEC §4). */
export type SpanCategory =
  | "app"
  | "db"
  | "http"
  | "cache"
  | "queue"
  | "other"
  | "job"
  | "command"
  | "schedule";

// ---------------------------------------------------------------------------
// AnyValue helpers
// ---------------------------------------------------------------------------

export function stringValue(v: string): AnyValue {
  return { stringValue: v };
}

/** CONTRACT: intValue is a STRING, not a JSON number. */
export function intValue(v: bigint | number): AnyValue {
  return {
    intValue: typeof v === "bigint" ? v.toString() : Math.trunc(v).toString(),
  };
}

export function boolValue(v: boolean): AnyValue {
  return { boolValue: v };
}

export function doubleValue(v: number): AnyValue {
  return { doubleValue: v };
}

export function keyValue(key: string, value: AnyValue): KeyValue {
  return { key, value };
}

// ---------------------------------------------------------------------------
// Span accumulator
// ---------------------------------------------------------------------------

type AttrValue =
  | { kind: "string"; value: string }
  | { kind: "int"; value: bigint }
  | { kind: "double"; value: number }
  | { kind: "bool"; value: boolean };

/**
 * A single span, accumulated in-request and serialized to OTLP/JSON on flush.
 * Attribute insertion order is preserved (a Map) for deterministic output.
 */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  name: string;
  readonly kind: number;
  readonly startUnixNano: bigint;
  endUnixNano: bigint;

  private readonly attributes = new Map<string, AttrValue>();
  private readonly links: SpanLink[] = [];
  private statusCode: 0 | 1 | 2 = StatusCode.UNSET;
  private statusMessage: string | undefined;

  constructor(opts: {
    traceId: string;
    spanId: string;
    parentSpanId?: string | undefined;
    name: string;
    kind: number;
    startUnixNano: bigint;
    endUnixNano: bigint;
  }) {
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
    this.parentSpanId = opts.parentSpanId;
    this.name = opts.name;
    this.kind = opts.kind;
    this.startUnixNano = opts.startUnixNano;
    this.endUnixNano = opts.endUnixNano;
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setEnd(endUnixNano: bigint): this {
    this.endUnixNano = endUnixNano;
    return this;
  }

  setString(key: string, value: string): this {
    if (isSensitiveAttributeKey(key)) return this;
    this.attributes.set(key, {
      kind: "string",
      value: key.toLowerCase() === "url.full" ? redactUrl(value, []) : value,
    });
    return this;
  }

  /** Record an int attribute. Serialized as intValue (a STRING) per the contract. */
  setInt(key: string, value: bigint | number): this {
    if (isSensitiveAttributeKey(key)) return this;
    this.attributes.set(key, {
      kind: "int",
      value: typeof value === "bigint" ? value : BigInt(Math.trunc(value)),
    });
    return this;
  }

  setDouble(key: string, value: number): this {
    if (isSensitiveAttributeKey(key)) return this;
    this.attributes.set(key, { kind: "double", value });
    return this;
  }

  setBool(key: string, value: boolean): this {
    if (isSensitiveAttributeKey(key)) return this;
    this.attributes.set(key, { kind: "bool", value });
    return this;
  }

  getString(key: string): string | undefined {
    const a = this.attributes.get(key);
    return a && a.kind === "string" ? a.value : undefined;
  }

  addLink(traceId: string, spanId: string, kind = "enqueue"): this {
    this.links.push({
      traceId,
      spanId,
      attributes: [keyValue("restlytics.link.kind", stringValue(kind))],
    });
    return this;
  }

  setStatus(code: 0 | 1 | 2, message?: string): this {
    this.statusCode = code;
    this.statusMessage = redactExceptionMessage(message);
    return this;
  }

  getStatusCode(): 0 | 1 | 2 {
    return this.statusCode;
  }

  /** Duration in nanoseconds (clamped non-negative against clock skew). */
  durationNs(): bigint {
    const d = this.endUnixNano - this.startUnixNano;
    return d < 0n ? 0n : d;
  }

  /** Serialize to the OTLP/JSON Span shape the ingestion contract validates. */
  toOtlp(): OtlpSpan {
    const span: OtlpSpan = {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: this.kind,
      // Decimal STRINGS — int64-safe in JSON.
      startTimeUnixNano: this.startUnixNano.toString(),
      endTimeUnixNano: this.endUnixNano.toString(),
    };

    // parentSpanId is omitted/empty for the root SERVER span.
    if (this.parentSpanId !== undefined && this.parentSpanId !== "") {
      span.parentSpanId = this.parentSpanId;
    }

    if (this.attributes.size > 0) {
      const attrs: KeyValue[] = [];
      for (const [key, av] of this.attributes) {
        attrs.push(keyValue(key, anyValueOf(av)));
      }
      span.attributes = attrs;
    }
    if (this.links.length > 0) span.links = [...this.links];

    // Only attach status when it carries signal (OK/ERROR); UNSET is the default.
    if (this.statusCode !== StatusCode.UNSET) {
      const status: SpanStatus = { code: this.statusCode };
      if (this.statusMessage !== undefined && this.statusMessage !== "") {
        status.message = this.statusMessage;
      }
      span.status = status;
    }

    return span;
  }
}

function anyValueOf(av: AttrValue): AnyValue {
  switch (av.kind) {
    case "string":
      return stringValue(av.value);
    case "int":
      return intValue(av.value);
    case "double":
      return doubleValue(av.value);
    case "bool":
      return boolValue(av.value);
  }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

export const SDK_NAME = "restlytics-node";
export const SDK_LANGUAGE = "nodejs";
export const SDK_VERSION = "0.1.0";

/**
 * Build the top-level OTLP/JSON ExportTraceServiceRequest body. A single
 * resourceSpans/scopeSpans envelope is emitted because every span in one request
 * shares the same resource.
 */
export function buildPayload(
  serviceName: string,
  environment: string,
  spans: readonly Span[],
): ExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: resourceAttributes(serviceName, environment),
        },
        scopeSpans: [
          {
            scope: { name: SDK_NAME, version: SDK_VERSION },
            spans: spans.map((s) => s.toOtlp()),
          },
        ],
      },
    ],
  };
}

function resourceAttributes(
  serviceName: string,
  environment: string,
): KeyValue[] {
  return [
    keyValue("service.name", stringValue(serviceName)),
    keyValue("deployment.environment", stringValue(environment)),
    keyValue("telemetry.sdk.name", stringValue(SDK_NAME)),
    keyValue("telemetry.sdk.language", stringValue(SDK_LANGUAGE)),
    keyValue("telemetry.sdk.version", stringValue(SDK_VERSION)),
  ];
}
