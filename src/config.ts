/**
 * Configuration resolution: env vars (SPEC §7) merged with a native config object.
 * Explicit options always win over env, which wins over defaults.
 */

export type TransportName = 'http' | 'null' | 'log' | 'preview';

export interface RedactionConfig {
  /** Query-string keys scrubbed from `url.full` (outbound HTTP) and dropped wholesale. */
  queryKeys: string[];
  /** Header names scrubbed wherever headers are read (lowercased). */
  headers: string[];
}

export interface InstrumentToggles {
  db: boolean;
  http: boolean;
  cache: boolean;
}

/** User-supplied options for {@link resolveConfig} — every field optional. */
export interface RestlyticsOptions {
  key?: string;
  ingestUrl?: string;
  serviceName?: string;
  env?: string;
  sampleRate?: number;
  transport?: TransportName;
  timeoutMs?: number;
  captureSql?: boolean;
  instruments?: Partial<InstrumentToggles>;
  ignorePaths?: string[];
  maxSpans?: number;
  /** Opt in to native OTLP log export. Disabled by default. */
  logs?: boolean;
  /** Minimum OpenTelemetry severity number exported (default WARN = 13). */
  logsMinSeverity?: number;
  redaction?: Partial<RedactionConfig>;
  /** Optional error sink for transport/instrumentation failures (never throws). */
  onError?: (message: string, error?: unknown) => void;
}

/** Fully-resolved, non-optional config used internally. */
export interface ResolvedConfig {
  key: string;
  ingestUrl: string;
  serviceName: string;
  env: string;
  sampleRate: number;
  transport: TransportName;
  timeoutMs: number;
  captureSql: boolean;
  instruments: InstrumentToggles;
  ignorePaths: string[];
  maxSpans: number;
  logs: boolean;
  logsMinSeverity: number;
  redaction: RedactionConfig;
  onError: ((message: string, error?: unknown) => void) | undefined;
}

const DEFAULT_INGEST_URL = 'https://ingest.restlytics.com';

const DEFAULT_QUERY_KEYS = [
  'token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'access_token',
  'key',
  'signature',
];

/** Sensitive headers never captured (SPEC §6). */
const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
];

const DEFAULT_IGNORE_PATHS = ['/up', '/health', '/healthz', '/favicon.ico'];

function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envFloat(name: string): number | undefined {
  const v = envStr(name);
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function envInt(name: string): number | undefined {
  const v = envStr(name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean | undefined {
  const v = envStr(name);
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.0;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}

function clampSeverity(severity: number): number {
  if (!Number.isFinite(severity)) return 13;
  return Math.max(1, Math.min(24, Math.trunc(severity)));
}

/**
 * Resolve the final config. Precedence: explicit options > environment > default.
 */
export function resolveConfig(options: RestlyticsOptions = {}): ResolvedConfig {
  const transport = (options.transport ?? envStr('RESTLYTICS_TRANSPORT') ?? 'http') as string;
  const normalizedTransport: TransportName =
    transport === 'null' || transport === 'log' || transport === 'preview' ? transport : 'http';

  return {
    key: options.key ?? envStr('RESTLYTICS_KEY') ?? '',
    ingestUrl: stripTrailingSlash(
      options.ingestUrl ?? envStr('RESTLYTICS_INGEST_URL') ?? DEFAULT_INGEST_URL,
    ),
    serviceName:
      options.serviceName ??
      envStr('RESTLYTICS_SERVICE_NAME') ??
      envStr('SERVICE_NAME') ??
      'node',
    env: options.env ?? envStr('RESTLYTICS_ENV') ?? envStr('NODE_ENV') ?? 'production',
    sampleRate: clampRate(options.sampleRate ?? envFloat('RESTLYTICS_SAMPLE_RATE') ?? 1.0),
    transport: normalizedTransport,
    timeoutMs: options.timeoutMs ?? envInt('RESTLYTICS_TIMEOUT_MS') ?? 2000,
    captureSql: options.captureSql ?? envBool('RESTLYTICS_CAPTURE_SQL') ?? false,
    instruments: {
      db: options.instruments?.db ?? envBool('RESTLYTICS_INSTRUMENT_DB') ?? true,
      http: options.instruments?.http ?? envBool('RESTLYTICS_INSTRUMENT_HTTP') ?? true,
      cache: options.instruments?.cache ?? envBool('RESTLYTICS_INSTRUMENT_CACHE') ?? true,
    },
    ignorePaths: options.ignorePaths ?? splitList(envStr('RESTLYTICS_IGNORE_PATHS')) ?? DEFAULT_IGNORE_PATHS,
    maxSpans: options.maxSpans ?? envInt('RESTLYTICS_MAX_SPANS') ?? 2000,
    logs: options.logs ?? envBool('RESTLYTICS_LOGS') ?? false,
    logsMinSeverity: clampSeverity(
      options.logsMinSeverity ?? envInt('RESTLYTICS_LOGS_MIN_SEVERITY') ?? 13,
    ),
    redaction: {
      queryKeys: options.redaction?.queryKeys ?? DEFAULT_QUERY_KEYS,
      headers: (options.redaction?.headers ?? DEFAULT_SENSITIVE_HEADERS).map((h) => h.toLowerCase()),
    },
    onError: options.onError,
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function splitList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
