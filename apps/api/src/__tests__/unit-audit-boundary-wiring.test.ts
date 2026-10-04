/**
 * Every request that reaches the process passes the audit boundary.
 *
 * `runInboundAudit` only helps if `Bun.serve.fetch` routes EVERYTHING through
 * it. These assertions read the server modules as text (index.ts, the inbound
 * dispatcher, and the global middleware), because the server module starts
 * listening when imported. They fail when a new entrypoint is added outside
 * the boundary — a new `server.upgrade()` branch, a second `app.fetch()`, or
 * a narrower mount of the request audit — which is exactly how the four dark
 * entrypoints got there.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The server-side modules the boundary spans (KRTX-347 split): the entry's
// fetch wrapper, the inbound dispatcher, and the global middleware chain.
const indexSource = readFileSync(resolve(import.meta.dir, '../app/index.ts'), 'utf8');
const dispatchSource = readFileSync(resolve(import.meta.dir, '../app/inbound-dispatch.ts'), 'utf8');
const middlewareSource = readFileSync(resolve(import.meta.dir, '../http/middleware/http-middleware.ts'), 'utf8');
const source = indexSource + dispatchSource + middlewareSource;

function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`index.ts has no async function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

describe('the audit boundary wraps every entrypoint', () => {
  test('Bun.serve.fetch hands the whole dispatcher to runInboundAudit', () => {
    expect(indexSource).toContain(
      'return runInboundAudit(req, url, () => dispatchInbound(req, url, server, app));',
    );
  });

  test('the dispatcher is the only caller of app.fetch and of server.upgrade', () => {
    const everywhere = (needle: string) => source.split(needle).length - 1;
    // The dispatcher and its whole-block upgrade helpers share one module, so
    // the "only caller" scope is that module, not the single function body.
    const inDispatcher = (needle: string) => dispatchSource.split(needle).length - 1;

    expect(everywhere('app.fetch(')).toBe(1);
    expect(inDispatcher('app.fetch(')).toBe(1);
    expect(everywhere('server.upgrade(')).toBeGreaterThan(0);
    expect(inDispatcher('server.upgrade(')).toBe(everywhere('server.upgrade('));
  });

  test('every entrypoint the dispatcher routes outside Hono names its class', () => {
    const dispatcher = functionBody('dispatchInbound');
    for (const route of [
      "'app_origin', 'app_origin:websocket'",
      "'app_origin', 'app_origin'",
      "'preview_origin', 'preview_origin:websocket'",
      "'preview_origin', 'preview_origin'",
      "'ws_upgrade', 'ws:/v1/tunnel/ws'",
      "'ws_upgrade', 'ws:/v1/p/:sandboxId/:port/*'",
    ]) {
      // The origin branches carry their entrypoint inline; the two WS-upgrade
      // branches moved into whole-block helpers in the same module, so their
      // pins read the module instead of the one function body.
      const scope = route.startsWith("'ws_upgrade'") ? dispatchSource : dispatcher;
      expect(scope).toContain(`setInboundAuditEntrypoint(${route})`);
    }
  });

  test('the request audit covers every Hono route, not just /v1', () => {
    expect(middlewareSource).toContain("app.use('*', auditApiRequest);");
    expect(middlewareSource).not.toMatch(/app\.use\(['"]\/v1\/\*['"],\s*auditApiRequest\)/);
  });

  test('the Hono request context reuses the one the edge opened', () => {
    // A second runWithContext would give the handler a fresh store, and every
    // principal it bound would miss the edge's audit scope.
    expect(middlewareSource).toMatch(/if \(getRequestContext\(\)\) \{\s*await withRequestFields\(\);/);
  });
});
