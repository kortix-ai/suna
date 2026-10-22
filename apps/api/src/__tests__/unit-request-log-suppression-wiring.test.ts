/**
 * The request-log suppression is wired through the REAL middleware chain: the
 * post-request logger reads `X-Kortix-Proxy-Hop` off the response the sandbox
 * proxy built and hands it to `shouldSuppressRequestLog`
 * (lib/request-log-level.ts). A designed boot-window answer
 * (`daemon` 503 on a proxied GET, KRTX-397) must produce NO `Request completed:`
 * line, while the classes that stay logged — a give-up 502, an unattributed
 * passthrough, a mutation — must still emit theirs at WARN.
 *
 * This drives the REAL global middleware chain (`installHttpMiddleware`) on a
 * bare app — the wiring under test is the inline post-request logger, which is
 * not exported. The single request context is opened around `app.fetch`
 * exactly as the server edge does (unit-slow-request-stage-log.test.ts). The
 * shipped log line is captured at the Better Stack seam
 * (unit-logger-context.test.ts), because lib/logger writes its WARN level
 * through the module-bound original console.warn that a test cannot re-hook.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

type LogCall = { level: string; message: string };
const logCalls: LogCall[] = [];

// The middleware chain mounts the audit boundary, whose synchronous test-env
// write needs a database this unit test does not own. Stub it: the boundary's
// behavior is covered by the audit suites; this test needs only the chain.
const realAudit = await import('../middleware/audit');
mock.module('../middleware/audit', () => ({
  ...realAudit,
  auditApiRequest: async (_c: unknown, next: () => Promise<unknown>) => next(),
}));

// lib/logger ships every level through Logtail; capture there — its WARN level
// goes to the module-bound original console.warn, invisible to a console hook.
mock.module('@logtail/node', () => ({
  Logtail: class {
    constructor(_token: string, _options: Record<string, unknown>) {}
    debug(message: string) {
      logCalls.push({ level: 'debug', message });
    }
    info(message: string) {
      logCalls.push({ level: 'info', message });
    }
    warn(message: string) {
      logCalls.push({ level: 'warn', message });
    }
    error(message: string) {
      logCalls.push({ level: 'error', message });
    }
    async flush() {}
  },
}));

process.env.BETTERSTACK_API_LOG_TOKEN = 'log-token-test';
process.env.BETTERSTACK_API_LOG_HOST = 'logs.example.test';

const PROXIED_GET = '/v1/p/ext-1/8000/lsp/diagnostics';

async function completedLines(reply: {
  status: 502 | 503;
  hop: string | null;
  upstreamStatus: number | null;
  method?: string;
  path?: string;
}): Promise<{ level: string; message: string; status: number }[]> {
  const { installHttpMiddleware } = await import('../http-middleware');
  const { runWithContext } = await import('../lib/request-context');

  const app = new OpenAPIHono();
  installHttpMiddleware(app);
  app.on(['GET', 'POST'], '/v1/p/:a/:b/*', (c) => {
    if (reply.hop) c.header('X-Kortix-Proxy-Hop', reply.hop);
    if (reply.upstreamStatus !== null) c.header('X-Kortix-Upstream-Status', String(reply.upstreamStatus));
    return c.json({ error: 'upstream answered' }, reply.status);
  });
  const env = {
    fetch: (request: Request): Promise<Response> =>
      runWithContext(request.method, new URL(request.url).pathname, () =>
        app.fetch(request),
      ) as Promise<Response>,
  };
  const method = reply.method ?? 'GET';
  const res = await env.fetch(new Request(`http://local${reply.path ?? PROXIED_GET}`, { method }));
  const logged = logCalls.filter((call) => call.message.includes('Request completed:'));
  return logged.map((call) => ({ ...call, status: res.status }));
}

describe('the middleware suppresses the designed boot-window log line', () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  test('a daemon 503 on a proxied GET emits no Request completed line (KRTX-397)', async () => {
    // The shape the not-ready passthrough leaves the proxy with: hop `daemon`,
    // the daemon's own 503 as the upstream status.
    const lines = await completedLines({ status: 503, hop: 'daemon', upstreamStatus: 503 });
    expect(lines).toEqual([]);
  });

  test('a give-up 502 still logs at WARN (KRTX-397)', async () => {
    // http-middleware.ts rewrites every 502 to a wire 503 (Cloudflare would
    // otherwise eat the body) with the honest 502 in the upstream-status
    // header — but the post-request logger runs BEFORE that rewriter, so the
    // line carries the internal 502. Either way: an outage signal, and it
    // must survive the suppression.
    const lines = await completedLines({ status: 502, hop: 'daemon', upstreamStatus: 502 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.message).toContain(' 502 ');
    // The wire response is the rewritten 503, untouched by any of this.
    expect(lines[0]!.status).toBe(503);
  });

  test('an unattributed 503 still logs at WARN', async () => {
    const lines = await completedLines({ status: 503, hop: null, upstreamStatus: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.message).toContain(' 503 ');
  });

  test('a mutation through the boot window still logs, daemon hop included', async () => {
    const lines = await completedLines({
      status: 503,
      hop: 'daemon',
      upstreamStatus: 503,
      method: 'POST',
      path: '/v1/p/ext-1/8000/log',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
  });
});
