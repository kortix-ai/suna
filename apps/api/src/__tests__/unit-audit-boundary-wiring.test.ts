/**
 * Every request that reaches the process passes the audit boundary.
 *
 * `runInboundAudit` only helps if `Bun.serve.fetch` routes EVERYTHING through
 * it. These assertions read `src/index.ts` as text, because the server module
 * starts listening when imported. They fail when a new entrypoint is added
 * outside the boundary — a new `server.upgrade()` branch, a second
 * `app.fetch()`, or a narrower mount of the request audit — which is exactly
 * how the four dark entrypoints got there.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
const dispatcherSource = readFileSync(resolve(import.meta.dir, '../inbound-dispatch.ts'), 'utf8');
const middlewareSource = readFileSync(resolve(import.meta.dir, '../http-middleware.ts'), 'utf8');
const appSource = readFileSync(resolve(import.meta.dir, '../app.ts'), 'utf8');

function functionBody(name: string): string {
  const start = dispatcherSource.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`inbound-dispatch.ts has no async function ${name}`);
  const end = dispatcherSource.indexOf('\n}', start);
  return dispatcherSource.slice(start, end);
}

describe('the audit boundary wraps every entrypoint', () => {
  test('Bun.serve.fetch hands the whole dispatcher to runInboundAudit', () => {
    expect(source).toContain('return runInboundAudit(req, url, () => inbound.dispatchInbound(req, url, server));');
    expect(source).toContain('createInboundDispatch(app,');
  });

  test('the dispatcher is the only caller of app.fetch and of server.upgrade', () => {
    const dispatcher = functionBody('dispatchInbound');
    const everywhere = (needle: string) => dispatcherSource.split(needle).length - 1;
    const inDispatcher = (needle: string) => dispatcher.split(needle).length - 1;

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
      expect(dispatcher).toContain(`setInboundAuditEntrypoint(${route})`);
    }
  });

  test('the request audit covers every Hono route, not just /v1', () => {
    expect(appSource).toContain('installHttpMiddleware(app)');
    expect(middlewareSource).toContain("app.use('*', auditApiRequest);");
    expect(middlewareSource).not.toMatch(/app\.use\(['"]\/v1\/\*['"],\s*auditApiRequest\)/);
  });

  test('the Hono request context reuses the one the edge opened', () => {
    // A second runWithContext would give the handler a fresh store, and every
    // principal it bound would miss the edge's audit scope.
    expect(middlewareSource).toMatch(/if \(getRequestContext\(\)\) \{\s*await withRequestFields\(\);/);
  });
});
