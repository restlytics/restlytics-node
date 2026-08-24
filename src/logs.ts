import type { ResolvedConfig } from './config.js';
import {
  SDK_NAME,
  SDK_VERSION,
  buildResource,
  boolValue,
  doubleValue,
  intValue,
  keyValue,
  stringValue,
  type AnyValue,
  type InstrumentationScope,
  type KeyValue,
  type Resource,
} from './otlp.js';
import { isSensitiveAttributeKey, redactText } from './redact.js';
import type { Tracer } from './tracer.js';
import type { Transport } from './transport.js';

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  severityNumber: number;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
  traceId?: string;
  spanId?: string;
}

export interface ScopeLogs {
  scope?: InstrumentationScope;
  logRecords: OtlpLogRecord[];
  schemaUrl?: string;
}

export interface ResourceLogs {
  resource?: Resource;
  scopeLogs: ScopeLogs[];
  schemaUrl?: string;
}

/** Top-level OTLP logs request — the body of `POST /v1/logs`. */
export interface ExportLogsServiceRequest {
  resourceLogs: ResourceLogs[];
}

export type LogSeverity =
  | 'trace'
  | 'debug'
  | 'info'
  | 'notice'
  | 'warn'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency'
  | 'fatal'
  | string
  | number;

export interface LogEmitterOptions {
  /** Hard in-memory record cap. */
  maxBufferedRecords?: number;
  /** Records per OTLP export. */
  batchSize?: number;
  /** Maximum time a partial batch waits before export. */
  flushIntervalMs?: number;
  /** Maximum serialized message characters. */
  maxBodyLength?: number;
  /** Maximum number of safe scalar attributes retained per record. */
  maxAttributes?: number;
}

export interface LogEmitterDiagnostics {
  readonly acceptedRecords: number;
  readonly droppedRecords: number;
  readonly exportedBatches: number;
  readonly bufferedRecords: number;
  readonly bufferCapacity: number;
  readonly closed: boolean;
}

export interface SeverityMapping {
  readonly severityNumber: number;
  readonly severityText: 'DEBUG' | 'INFO' | 'INFO2' | 'WARN' | 'ERROR' | 'ERROR2' | 'FATAL';
}

const DEFAULT_MAX_BUFFERED_RECORDS = 256;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BODY_LENGTH = 8_192;
const DEFAULT_MAX_ATTRIBUTES = 32;

/** Deterministic host-level → OpenTelemetry severity mapping (SPEC §12.3). */
export function mapLogSeverity(level: LogSeverity): SeverityMapping {
  if (typeof level === 'number') {
    const severityNumber = Number.isFinite(level)
      ? Math.max(1, Math.min(24, Math.trunc(level)))
      : 9;
    return { severityNumber, severityText: severityTextFor(severityNumber) };
  }

  switch (level.trim().toLowerCase()) {
    case 'trace':
    case 'debug':
      return { severityNumber: 5, severityText: 'DEBUG' };
    case 'notice':
      return { severityNumber: 10, severityText: 'INFO2' };
    case 'warn':
    case 'warning':
      return { severityNumber: 13, severityText: 'WARN' };
    case 'error':
      return { severityNumber: 17, severityText: 'ERROR' };
    case 'critical':
      return { severityNumber: 18, severityText: 'ERROR2' };
    case 'alert':
    case 'emergency':
    case 'fatal':
      return { severityNumber: 21, severityText: 'FATAL' };
    case 'info':
    default:
      return { severityNumber: 9, severityText: 'INFO' };
  }
}

function severityTextFor(value: number): SeverityMapping['severityText'] {
  if (value >= 21) return 'FATAL';
  if (value >= 18) return 'ERROR2';
  if (value >= 17) return 'ERROR';
  if (value >= 13) return 'WARN';
  if (value >= 10) return 'INFO2';
  if (value >= 9) return 'INFO';
  return 'DEBUG';
}

/** Build the mode-agnostic OTLP logs envelope using the trace resource verbatim. */
export function buildLogsPayload(
  serviceName: string,
  environment: string,
  records: readonly OtlpLogRecord[],
): ExportLogsServiceRequest {
  return {
    resourceLogs: [
      {
        resource: buildResource(serviceName, environment),
        scopeLogs: [
          {
            scope: { name: SDK_NAME, version: SDK_VERSION },
            logRecords: [...records],
          },
        ],
      },
    ],
  };
}

/**
 * Bounded, opt-in native log capture. `record()` never throws and only buffers;
 * size, time, request/job completion, and explicit SDK flushes trigger export.
 */
export class LogEmitter {
  private readonly buffer: OtlpLogRecord[] = [];
  private readonly maxBufferedRecords: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBodyLength: number;
  private readonly maxAttributes: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private isClosed = false;
  private isExporting = false;
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private exportedBatches = 0;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly tracer: Tracer,
    private readonly transport: Transport,
    options: LogEmitterOptions = {},
  ) {
    this.maxBufferedRecords = positiveInt(
      options.maxBufferedRecords,
      DEFAULT_MAX_BUFFERED_RECORDS,
    );
    this.batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
    this.flushIntervalMs = nonNegativeInt(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.maxBodyLength = positiveInt(options.maxBodyLength, DEFAULT_MAX_BODY_LENGTH);
    this.maxAttributes = positiveInt(options.maxAttributes, DEFAULT_MAX_ATTRIBUTES);
  }

  record(
    severity: LogSeverity,
    message: unknown,
    attributes: Readonly<Record<string, unknown>> = {},
  ): boolean {
    try {
      if (!this.config.logs || this.isClosed || this.isExporting) return false;
      const mapped = mapLogSeverity(severity);
      if (mapped.severityNumber < this.config.logsMinSeverity) return false;
      if (this.buffer.length >= this.maxBufferedRecords) {
        this.recordDrop('restlytics: log record dropped because the log buffer is full');
        return false;
      }

      const timeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
      const safeAttributes = buildSafeAttributes(attributes, this.maxAttributes);
      const record: OtlpLogRecord = {
        timeUnixNano,
        observedTimeUnixNano: timeUnixNano,
        severityNumber: mapped.severityNumber,
        severityText: mapped.severityText,
        body: stringValue(safeMessage(message).slice(0, this.maxBodyLength)),
      };
      if (safeAttributes.values.length > 0) record.attributes = safeAttributes.values;
      if (safeAttributes.dropped > 0) record.droppedAttributesCount = safeAttributes.dropped;

      const traceId = this.tracer.currentTraceId();
      const spanId = this.tracer.currentSpanId();
      const flags = this.tracer.currentTraceFlags();
      if (traceId) record.traceId = traceId;
      if (spanId) record.spanId = spanId;
      if (flags !== undefined) record.flags = flags;

      this.buffer.push(record);
      this.acceptedRecords += 1;
      if (this.buffer.length >= this.batchSize) this.flush();
      else this.scheduleFlush();
      return true;
    } catch (error) {
      this.recordDrop('restlytics: log capture failed', error);
      return false;
    }
  }

  /** Drain buffered records into bounded OTLP batches without waiting on I/O. */
  flush(): void {
    this.clearTimer();
    while (this.buffer.length > 0) {
      const records = this.buffer.splice(0, this.batchSize);
      try {
        if (!this.transport.sendLogs) {
          this.droppedRecords += records.length;
          report(this.config, 'restlytics: log batch dropped because the transport does not support logs');
          continue;
        }
        this.isExporting = true;
        this.transport.sendLogs(buildLogsPayload(this.config.serviceName, this.config.env, records));
        this.exportedBatches += 1;
      } catch (error) {
        this.droppedRecords += records.length;
        report(this.config, 'restlytics: log export failed', error);
      } finally {
        this.isExporting = false;
      }
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.flush();
    this.isClosed = true;
  }

  diagnostics(): LogEmitterDiagnostics {
    return {
      acceptedRecords: this.acceptedRecords,
      droppedRecords: this.droppedRecords,
      exportedBatches: this.exportedBatches,
      bufferedRecords: this.buffer.length,
      bufferCapacity: this.maxBufferedRecords,
      closed: this.isClosed,
    };
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushIntervalMs === 0) {
      if (this.flushIntervalMs === 0) this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private recordDrop(message: string, error?: unknown): void {
    this.droppedRecords += 1;
    report(this.config, message, error);
  }
}

function report(config: ResolvedConfig, message: string, error?: unknown): void {
  try {
    config.onError?.(message, error);
  } catch {
    // Error reporting must preserve the never-throw guarantee too.
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function safeMessage(message: unknown): string {
  if (message instanceof Error) return `[${safeErrorName(message.name)}]`;
  if (typeof message === 'string') return redactText(message);
  if (typeof message === 'number' || typeof message === 'bigint' || typeof message === 'boolean') {
    return String(message);
  }
  if (message === null || message === undefined) return '';
  // Arbitrary objects can contain request bodies, bindings, and exception data.
  // Structured scalar fields belong in `attributes`, where keys are filtered.
  return '[object]';
}

function safeErrorName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function buildSafeAttributes(
  attributes: Readonly<Record<string, unknown>>,
  maxAttributes: number,
): { values: KeyValue[]; dropped: number } {
  const values: KeyValue[] = [];
  let dropped = 0;
  for (const [rawKey, rawValue] of Object.entries(attributes)) {
    const key = rawKey.trim().slice(0, 128);
    if (
      key === '' ||
      isSensitiveAttributeKey(key) ||
      key === 'msg' ||
      key === 'message' ||
      key === 'level' ||
      key === 'time'
    ) {
      dropped += 1;
      continue;
    }
    if (values.length >= maxAttributes) {
      dropped += 1;
      continue;
    }
    const value = safeAttributeValue(key, rawValue);
    if (!value) {
      dropped += 1;
      continue;
    }
    values.push(keyValue(key, value));
  }
  return { values, dropped };
}

function safeAttributeValue(key: string, value: unknown): AnyValue | undefined {
  if (typeof value === 'string') {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '.');
    const sourceSafeValue =
      normalizedKey === 'source.file.path' || normalizedKey === 'code.filepath'
        ? (value.split(/[\\/]/).pop() ?? '')
        : value;
    return stringValue(redactText(sourceSafeValue).slice(0, 1_024));
  }
  if (typeof value === 'boolean') return boolValue(value);
  if (typeof value === 'bigint') return intValue(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? intValue(value) : doubleValue(value);
  }
  return undefined;
}

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error';
type ConsoleTarget = Record<ConsoleMethod, (...args: unknown[]) => void>;

/**
 * Optional in-process console hook. Original methods and return behaviour are
 * preserved; call the returned function to restore them.
 */
export function instrumentConsoleLogs(
  sdk: { log: LogEmitter['record'] },
  target: ConsoleTarget = console,
): () => void {
  const levels: Record<ConsoleMethod, LogSeverity> = {
    debug: 'debug',
    info: 'info',
    log: 'info',
    warn: 'warn',
    error: 'error',
  };
  const restorers: Array<() => void> = [];
  for (const name of Object.keys(levels) as ConsoleMethod[]) {
    const original = target[name];
    const replacement = (...args: unknown[]) => {
      try {
        sdk.log(levels[name], consoleMessage(args));
      } catch {
        // Capturing must never alter console behaviour.
      }
      original.apply(target, args);
    };
    target[name] = replacement;
    restorers.push(() => {
      if (target[name] === replacement) target[name] = original;
    });
  }
  return () => {
    for (const restore of restorers) restore();
  };
}

function consoleMessage(args: readonly unknown[]): string {
  return args.map((value) => safeMessage(value)).join(' ');
}

/** Pino numeric levels mapped without interpreting them as OTLP numbers. */
export function mapPinoSeverity(level: number): LogSeverity {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  return 'debug';
}

/**
 * Pino `hooks.logMethod` adapter. It stays in-thread so AsyncLocalStorage trace
 * context remains available; worker-thread transports cannot preserve it.
 */
export function createPinoLogMethodHook(sdk: { log: LogEmitter['record'] }) {
  return function restlyticsPinoLogMethod(
    this: unknown,
    args: unknown[],
    method: (...args: unknown[]) => unknown,
    level: number,
  ): unknown {
    try {
      const first = args[0];
      const attributes = isRecord(first) ? first : {};
      const message = typeof first === 'string'
        ? first
        : typeof args[1] === 'string'
          ? args[1]
          : '';
      sdk.log(mapPinoSeverity(level), message, attributes);
    } catch {
      // Preserve logger behaviour even if capture fails.
    }
    return method.apply(this, args);
  };
}

/** Winston-format-friendly capture: call from an in-process format transform. */
export function captureWinstonLog(
  sdk: { log: LogEmitter['record'] },
  info: Readonly<Record<string, unknown>>,
): void {
  try {
    const level = typeof info.level === 'string' ? info.level : 'info';
    sdk.log(level, info.message, info);
  } catch {
    // Capture is observational and must not affect Winston.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
