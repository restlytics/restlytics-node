import * as Ids from './ids.js';
import { SpanKind, StatusCode, type SpanCategory } from './otlp.js';
import type { RequestTrace, Tracer } from './tracer.js';

export interface QueueCarrier {
  __restlytics?: { traceparent: string; tracestate?: string };
  [key: string]: unknown;
}

export interface JobOptions {
  name: string;
  system: string;
  destination: string;
  attempt?: number;
  maxAttempts?: number;
  enqueuedNs?: bigint | number;
  messageId?: string;
  traceparent?: string;
}

export interface CommandOptions {
  name: string;
  traceparent?: string;
}

export interface ScheduleOptions {
  name: string;
  cron: string;
  traceparent?: string;
}

export interface EnqueueOptions {
  system: string;
  destination: string;
  tracestate?: string;
}

function stableName(value: string, fallback: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || fallback;
}

async function runWork<T>(
  tracer: Tracer,
  name: string,
  category: SpanCategory,
  kind: number,
  traceparent: string | undefined,
  configure: (trace: RequestTrace) => void,
  operation: () => T | Promise<T>,
): Promise<T> {
  const trace = tracer.begin(traceparent);
  const root = tracer.openRoot(trace, stableName(name, `unnamed-${category}`), {
    kind,
    category,
    linkParent: category === 'job',
  });
  root?.setString('restlytics.work.name', stableName(name, `unnamed-${category}`));
  configure(trace);
  return tracer.run(trace, async () => {
    try {
      const result = await operation();
      if (root?.getStatusCode() === StatusCode.UNSET) root.setStatus(StatusCode.OK);
      return result;
    } catch (error) {
      root?.setStatus(StatusCode.ERROR);
      throw error;
    } finally {
      trace.finish(tracer.transport);
    }
  });
}

export function runJob<T>(tracer: Tracer, options: JobOptions, operation: () => T | Promise<T>) {
  return runWork(
    tracer,
    options.name,
    'job',
    SpanKind.CONSUMER,
    options.traceparent,
    (trace) => {
      const root = trace.rootSpan;
      root?.setString('restlytics.job.name', stableName(options.name, 'unnamed-job'));
      root?.setString('messaging.system', stableName(options.system, 'unknown'));
      root?.setString('messaging.destination.name', stableName(options.destination, 'unknown'));
      root?.setString('messaging.operation.type', 'process');
      root?.setInt('restlytics.job.attempt', Math.max(1, Math.trunc(options.attempt ?? 1)));
      if (options.maxAttempts !== undefined) {
        root?.setInt('restlytics.job.max_attempts', Math.max(1, Math.trunc(options.maxAttempts)));
      }
      if (options.enqueuedNs !== undefined) root?.setInt('restlytics.job.enqueued_ns', options.enqueuedNs);
      if (options.messageId) root?.setString('messaging.message.id', stableName(options.messageId, 'unknown'));
    },
    operation,
  );
}

export function runCommand(
  tracer: Tracer,
  options: CommandOptions,
  operation: () => number | void | Promise<number | void>,
): Promise<number | void> {
  return runWork(
    tracer,
    options.name,
    'command',
    SpanKind.SERVER,
    options.traceparent,
    () => undefined,
    async () => {
      const result = await operation();
      const exitCode = typeof result === 'number' ? Math.trunc(result) : 0;
      const root = tracer.current()?.rootSpan;
      root?.setString('restlytics.command.name', stableName(options.name, 'unnamed-command'));
      root?.setInt('restlytics.command.exit_code', exitCode);
      if (exitCode !== 0) root?.setStatus(StatusCode.ERROR);
      return result;
    },
  );
}

export function runSchedule<T>(
  tracer: Tracer,
  options: ScheduleOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  return runWork(
    tracer,
    options.name,
    'schedule',
    SpanKind.SERVER,
    options.traceparent,
    (trace) => {
      trace.rootSpan?.setString('restlytics.schedule.name', stableName(options.name, 'unnamed-schedule'));
      trace.rootSpan?.setString('restlytics.schedule.cron', stableName(options.cron, 'unknown'));
    },
    operation,
  );
}

export async function runEnqueue<T>(
  tracer: Tracer,
  options: EnqueueOptions,
  carrier: QueueCarrier,
  operation: (carrier: QueueCarrier) => T | Promise<T>,
): Promise<T> {
  const trace = tracer.current();
  if (!trace) return operation(carrier);
  const enqueueSpanId = Ids.spanId();
  carrier.__restlytics = {
    traceparent: Ids.formatTraceparent(trace.traceId, enqueueSpanId, trace.sampled),
    ...(options.tracestate?.trim() ? { tracestate: options.tracestate.trim().slice(0, 512) } : {}),
  };
  const span = trace.startChild(
    `send ${stableName(options.destination, 'unknown')}`,
    'queue',
    SpanKind.CLIENT,
    enqueueSpanId,
  );
  span?.setString('messaging.system', stableName(options.system, 'unknown'));
  span?.setString('messaging.destination.name', stableName(options.destination, 'unknown'));
  span?.setString('messaging.operation.type', 'send');
  try {
    const result = await operation(carrier);
    span?.setStatus(StatusCode.OK);
    return result;
  } catch (error) {
    span?.setStatus(StatusCode.ERROR);
    throw error;
  } finally {
    span?.setEnd(trace.nowNs());
  }
}
