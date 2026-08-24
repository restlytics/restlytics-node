import { StatusCode } from '../otlp.js';
import { Tracer } from '../tracer.js';
import { createExpressMiddleware } from './express.js';

/**
 * NestJS request hooks (SPEC §8). NestJS runs on an Express (or Fastify) HTTP
 * adapter, so two surfaces are offered:
 *
 *  1. {@link createNestMiddleware} — a plain `(req, res, next)` middleware you can
 *     register with `consumer.apply(...)`. It reuses the Express integration, so
 *     it opens the SERVER span at request start and flushes on `res` `finish`.
 *     This is the recommended hook because it sees the whole request lifecycle.
 *
 *  2. {@link RestlyticsInterceptor} — a `NestInterceptor` for when you prefer Nest's
 *     DI. It binds the AsyncLocalStorage scope around the handler and stamps the
 *     route template. Because interceptors run inside the request, flushing still
 *     happens on the response `finish` event for correct end-to-end timing.
 *
 * `@nestjs/common` and `rxjs` are OPTIONAL peers; we never import their types and
 * resolve them dynamically so this module loads even when Nest isn't installed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Plain connect-style middleware for `consumer.apply(...).forRoutes(...)`. */
export function createNestMiddleware(tracer: Tracer) {
  return createExpressMiddleware(tracer);
}

/**
 * A NestInterceptor (duck-typed so we don't depend on @nestjs/common types).
 * Construct it with a Tracer and register it as a global interceptor:
 *
 *   app.useGlobalInterceptors(new RestlyticsInterceptor(tracer));
 */
export class RestlyticsInterceptor {
  constructor(private readonly tracer: Tracer) {}

  intercept(context: any, next: { handle: () => any }): any {
    const tracer = this.tracer;

    // Only HTTP requests carry a request/response pair we can trace.
    let req: any;
    let res: any;
    try {
      const http = context.switchToHttp();
      req = http.getRequest();
      res = http.getResponse();
    } catch {
      return next.handle();
    }
    if (!req || !res) {
      return next.handle();
    }

    // If an upstream middleware already opened a trace for this request, just run
    // inside it; otherwise open one here.
    let trace = this.tracer.current();
    let ownsTrace = false;
    if (!trace) {
      try {
        trace = tracer.begin(headerValue(req, 'traceparent'));
        const method = methodOf(req);
        tracer.openRoot(trace, `${method} ${pathOf(req)}`);
        ownsTrace = true;
      } catch (err) {
        tracer.config.onError?.('restlytics: nest interceptor begin failed', err);
        return next.handle();
      }
    }

    const stampRoute = () => {
      try {
        const root = trace!.rootSpan;
        if (root === null) return;
        const template = nestRouteTemplate(context, req);
        const method = methodOf(req);
        const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
        root.setName(`${method} ${template}`);
        root.setString('http.request.method', method);
        root.setString('http.route', template);
        if (status > 0) root.setInt('http.response.status_code', status);
        if (status >= 500 && root.getStatusCode() !== StatusCode.ERROR) {
          root.setStatus(StatusCode.ERROR, `HTTP ${status}`);
        } else if (root.getStatusCode() === StatusCode.UNSET) {
          root.setStatus(StatusCode.OK);
        }
      } catch (err) {
        tracer.config.onError?.('restlytics: nest stampRoute failed', err);
      }
    };

    if (ownsTrace) {
      let finished = false;
      const finalize = () => {
        if (finished) return;
        finished = true;
        stampRoute();
        try {
          trace!.finish(tracer.transport);
          tracer.flushLogs();
        } catch (err) {
          tracer.config.onError?.('restlytics: nest finalize failed', err);
        }
      };
      res.on?.('finish', finalize);
      res.on?.('close', finalize);
    } else {
      // The Express/Nest middleware owns the flush; we just enrich the route here.
      stampRoute();
    }

    // Run the handler inside the AsyncLocalStorage scope so DB/HTTP instrumentation
    // attaches to this request.
    return tracer.run(trace!, () => next.handle());
  }
}

function methodOf(req: any): string {
  return typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
}

function pathOf(req: any): string {
  const raw: string = req.originalUrl ?? req.url ?? '/';
  const q = raw.indexOf('?');
  const p = q === -1 ? raw : raw.slice(0, q);
  return p === '' ? '/' : p;
}

function headerValue(req: any, name: string): string | undefined {
  const h = req.headers?.[name];
  if (Array.isArray(h)) return h[0];
  return typeof h === 'string' ? h : undefined;
}

/**
 * Route template for a Nest handler. Prefer the underlying Express route
 * (`req.route?.path` + baseUrl); fall back to the raw path. Nest mounts each
 * handler as an Express route, so `req.route.path` is the `@Get(':id')` template.
 */
function nestRouteTemplate(_context: any, req: any): string {
  const routePath: string | undefined = req.route?.path;
  if (routePath !== undefined && routePath !== null) {
    const base: string = req.baseUrl ?? '';
    const joined = `${base}${routePath}`.replace(/\/{2,}/g, '/');
    return joined === '' ? '/' : joined;
  }
  return pathOf(req);
}
