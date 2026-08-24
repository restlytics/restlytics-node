import { StatusCode } from '../otlp.js';
import { Tracer } from '../tracer.js';

/**
 * Express request hook (SPEC §8): a middleware that opens the root SERVER span at
 * request start and flushes the trace on the response `finish` event — i.e. AFTER
 * the response has been written, so our work is off the user's critical path.
 *
 * `express` is an OPTIONAL peer dependency, so we don't import its types. Request
 * and response are typed loosely as `any` to avoid a hard type/runtime dependency
 * on a framework the host may not have installed. The shapes we touch
 * (`req.method`, `req.headers`, `req.route?.path`, `req.baseUrl`, `res.on`,
 * `res.statusCode`) are stable across Express 4/5.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type ExpressReq = any;
type ExpressRes = any;
type NextFn = (err?: unknown) => void;

export interface ExpressMiddlewareOptions {
  /** Override the ignore-path matcher; defaults to the tracer config's ignorePaths. */
  ignorePaths?: string[];
}

export function createExpressMiddleware(tracer: Tracer, opts: ExpressMiddlewareOptions = {}) {
  const ignorePaths = opts.ignorePaths ?? tracer.config.ignorePaths;

  return function restlyticsExpressMiddleware(req: ExpressReq, res: ExpressRes, next: NextFn): void {
    let path = '/';
    try {
      path = pathOf(req);
      if (shouldIgnore(path, ignorePaths)) {
        next();
        return;
      }
    } catch {
      next();
      return;
    }

    let trace;
    try {
      const traceparent = headerValue(req, 'traceparent');
      trace = tracer.begin(traceparent);
      tracer.openRoot(trace, `${methodOf(req)} ${path}`);
    } catch (err) {
      tracer.config.onError?.('restlytics: express middleware begin failed', err);
      next();
      return;
    }

    // Flush exactly once, on whichever terminal event fires first.
    let finished = false;
    const finalize = () => {
      if (finished) return;
      finished = true;
      try {
        finishRequest(tracer, trace!, req, res);
      } catch (err) {
        tracer.config.onError?.('restlytics: express finalize failed', err);
      }
    };
    res.on('finish', finalize);
    res.on('close', finalize);

    // Run downstream inside the AsyncLocalStorage scope so DB/HTTP instrumentation
    // can find this request via tracer.current().
    tracer.run(trace, () => next());
  };
}

function finishRequest(tracer: Tracer, trace: ReturnType<Tracer['begin']>, req: ExpressReq, res: ExpressRes): void {
  const root = trace.rootSpan;
  if (root === null) return; // not sampled / ignored

  // http.route MUST be the TEMPLATE (e.g. /users/:id), never the raw URL, so
  // high-cardinality ids don't explode rollup grouping (SPEC §4, #1 rule).
  // Express exposes the matched route only after routing: req.route?.path,
  // joined with req.baseUrl for routers mounted under a prefix.
  const template = routeTemplate(req);
  const method = methodOf(req);
  const status = typeof res.statusCode === 'number' ? res.statusCode : 0;

  root.setName(`${method} ${template}`);
  root.setString('http.request.method', method);
  root.setString('http.route', template);
  if (status > 0) {
    root.setInt('http.response.status_code', status);
  }

  // 5xx (and missing status) become ERROR; otherwise mark OK.
  if (status >= 500) {
    if (root.getStatusCode() !== StatusCode.ERROR) {
      root.setStatus(StatusCode.ERROR, `HTTP ${status}`);
    }
  } else if (root.getStatusCode() === StatusCode.UNSET) {
    root.setStatus(StatusCode.OK);
  }

  trace.finish(tracer.transport);
  tracer.flushLogs();
}

function methodOf(req: ExpressReq): string {
  return typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
}

/** Raw request path (no query string) for ignore-matching and the provisional name. */
function pathOf(req: ExpressReq): string {
  const raw: string = req.originalUrl ?? req.url ?? '/';
  const q = raw.indexOf('?');
  const p = q === -1 ? raw : raw.slice(0, q);
  return p === '' ? '/' : p;
}

/** Resolved route template, falling back to the raw path for unmatched routes (404s). */
function routeTemplate(req: ExpressReq): string {
  const routePath: string | undefined = req.route?.path;
  if (routePath !== undefined && routePath !== null) {
    const base: string = req.baseUrl ?? '';
    const joined = `${base}${routePath}`.replace(/\/{2,}/g, '/');
    return joined === '' ? '/' : joined;
  }
  return pathOf(req);
}

function headerValue(req: ExpressReq, name: string): string | undefined {
  const h = req.headers?.[name];
  if (Array.isArray(h)) return h[0];
  return typeof h === 'string' ? h : undefined;
}

function shouldIgnore(path: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const pattern = raw.startsWith('/') ? raw : `/${raw}`;
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === path) {
      return true;
    }
  }
  return false;
}
