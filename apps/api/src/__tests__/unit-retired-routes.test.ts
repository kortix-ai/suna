import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import { ENDPOINT_RETIRED_CODE, RETIRED_ROUTES, registerRetiredRoutes } from '../routes/retired';

const { app } = await import('../index');

type RouteRow = { method: string; path: string; handler: (...args: unknown[]) => unknown };

const retiredApp = new OpenAPIHono();
registerRetiredRoutes(retiredApp);
const gone = (retiredApp.routes as RouteRow[])[0]!.handler;

/** A concrete request for a route template: `:param` → `x`, `*` → `a/b`. */
function requests(method: string, path: string): Array<[string, string]> {
  const url = path.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'a/b');
  return method === 'ALL' ? [['GET', url], ['POST', url]] : [[method, url]];
}

const ROWS = RETIRED_ROUTES.flatMap(([method, path]) => requests(method, path));

/** Does a Hono route template match this concrete path? */
function matches(template: string, url: string): boolean {
  const pattern = template
    .split('/')
    .map((segment) =>
      segment === '*' ? '.*' : segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}/?$`).test(url);
}

describe('retired routes', () => {
  test('the table lists every route once', () => {
    const keys = RETIRED_ROUTES.map(([method, path]) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(30);
  });

  test.each(ROWS)('%s %s answers 410 ENDPOINT_RETIRED', async (method, url) => {
    const res = await retiredApp.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: 'This endpoint was removed from the Kortix API.',
      code: ENDPOINT_RETIRED_CODE,
    });
  });

  // Hono dispatches handlers in registration order. In the real app the first
  // handler (not middleware) that matches a retired URL must be the 410 stub,
  // so no surviving mount (`GET /v1/projects/:projectId`, the router proxy)
  // can answer it first.
  test.each(ROWS)('the real app answers %s %s with the 410 stub first', (method, url) => {
    const first = (app.routes as RouteRow[]).find(
      (route) =>
        (route.method === method || route.method === 'ALL') &&
        route.handler.length < 2 &&
        matches(route.path, url),
    );
    expect(first?.handler).toBe(gone);
  });

  test('every retired route is in the real route table', () => {
    const live = new Set((app.routes as RouteRow[]).map((route) => `${route.method} ${route.path}`));
    const missing = RETIRED_ROUTES.map(([method, path]) => `${method} ${path}`).filter(
      (key) => !live.has(key),
    );
    expect(missing).toEqual([]);
  });
});
