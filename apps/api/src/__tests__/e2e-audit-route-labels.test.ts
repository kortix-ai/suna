/**
 * Every request row carries its route's audit label.
 *
 * The row's `action` is the label's `domain.resource.verb` from
 * `@kortix/shared/audit-labels`, not `METHOD /template`. The template stays
 * readable in `metadata.http`. The expected labels are read from the catalog,
 * so renaming a label never breaks this file; what it pins is which route a
 * row is attributed to — including a request a middleware refused before the
 * endpoint ran, which used to be recorded under the middleware's wildcard.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  auditLabelForEntrypoint,
  auditLabelForRoute,
  UNMATCHED_ROUTE_LABEL,
} from '@kortix/shared/audit-labels';
import { Hono } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppEnv } from '../types';

let auditRows: Array<Record<string, unknown>> = [];

function captured(values: Record<string, unknown> | Array<Record<string, unknown>>) {
  for (const row of Array.isArray(values) ? values : [values]) auditRows.push(row);
  return {
    returning: async () => [{ eventId: 'audit_test' }],
    onConflictDoNothing: async () => undefined,
  };
}

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({ values: captured }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => [],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
      };
      return chain;
    },
  },
}));

const { recordAuditEvent } = await import('../shared/audit');
const { auditApiRequest } = await import('../middleware/audit');
const { runInboundAudit } = await import('../shared/audit-edge');
const { annotateAuditEvent, setInboundAuditEntrypoint } = await import('../shared/audit-scope');

/** The shape of the real API: an auth middleware on a sub-router, then the endpoints. */
function projectsApp(): Hono {
  const projects = new Hono();
  projects.use('/*', async (c, next) =>
    c.req.header('authorization') ? next() : c.json({ error: 'unauthorized' }, 401),
  );
  projects.get('/', (c) => c.json([]));
  projects.post('/', async (c) => {
    if (c.req.header('x-annotate')) annotateAuditEvent({ action: 'git.push' });
    const record = c.req.header('x-record');
    if (record) {
      await recordAuditEvent({
        action: record === 'same' ? label('POST', '/v1/projects').action : 'project.repository.link',
        resourceType: 'project',
        resourceId: 'p',
        after: { name: 'Demo' },
      });
    }
    if (c.req.header('x-fail')) return c.json({ error: 'boom' }, 500);
    return c.json({ project_id: 'p' }, 201);
  });
  // The order of `projects/routes/gateway-logs.ts`: `facets` before `/:logId`,
  // which also matches `facets`. Hono runs the first one.
  projects.get('/:projectId/gateway/logs/facets', (c) => c.json({ models: [] }));
  projects.get('/:projectId/gateway/logs/:logId', (c) => c.json({ log_id: c.req.param('logId') }));
  const app = new Hono();
  app.use('*', auditApiRequest);
  app.route('/v1/projects', projects);
  app.all('/v1/p/:sandboxId/:port/*', (c) => c.text('proxied'));
  app.get('/v1/test-only-unlabelled', (c) => c.text('ok'));
  return app;
}

function label(method: string, route: string) {
  const found = auditLabelForRoute(method, route);
  if (!found) throw new Error(`catalog has no label for ${method} ${route}`);
  return found;
}

describe('a request row carries its route label', () => {
  beforeEach(() => {
    auditRows = [];
  });

  test('a labelled route writes the label action and keeps the template in metadata.http', async () => {
    const res = await projectsApp().request('/v1/projects', { headers: { authorization: 'Bearer t' } });

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe(label('GET', '/v1/projects').action);
    expect(auditRows[0]?.metadata).toMatchObject({ http: 'GET /v1/projects', path: '/v1/projects' });
  });

  test('a request a middleware refused is attributed to the endpoint, not the middleware wildcard', async () => {
    const res = await projectsApp().request('/v1/projects', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: label('POST', '/v1/projects').action,
      outcome: 'denied',
      httpStatus: 401,
    });
    expect(auditRows[0]?.metadata).toMatchObject({ http: 'POST /v1/projects', path: '/v1/projects' });
  });

  test('a catch-all handler writes its label for any method', async () => {
    const res = await projectsApp().request('/v1/p/sbx/8000/api/items', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(auditRows[0]?.action).toBe(label('DELETE', '/v1/p/:sandboxId/:port/*').action);
    expect(auditRows[0]?.metadata).toMatchObject({
      http: 'DELETE /v1/p/:sandboxId/:port/*',
      path: '/v1/p/:sandboxId/:port/*',
    });
  });

  test('a request no endpoint matched is written as unmatched, never under a raw path', async () => {
    const res = await projectsApp().request('/v1/projects/p1/no-such-thing', {
      headers: { authorization: 'Bearer t' },
    });

    expect(res.status).toBe(404);
    expect(auditRows[0]?.action).toBe(UNMATCHED_ROUTE_LABEL.action);
    expect(auditRows[0]?.metadata).toMatchObject({ path: '<unmatched>' });
    expect(JSON.stringify(auditRows[0])).not.toContain('no-such-thing');
  });

  test("a handler's own domain action still wins over the route label", async () => {
    await projectsApp().request('/v1/projects', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'x-annotate': '1' },
    });

    expect(auditRows[0]?.action).toBe('git.push');
    expect(auditRows[0]?.metadata).toMatchObject({ http: 'POST /v1/projects' });
  });

  test('a route with no label keeps `METHOD /template` and adds no metadata.http', async () => {
    await projectsApp().request('/v1/test-only-unlabelled');

    expect(auditRows[0]?.action).toBe('GET /v1/test-only-unlabelled');
    expect(auditRows[0]?.metadata).not.toHaveProperty('http');
  });

  test('a request dispatched before the router writes its entrypoint label', async () => {
    const url = new URL('https://preview.test/');
    await runInboundAudit(new Request(url), url, async () => {
      setInboundAuditEntrypoint('preview_origin', 'preview_origin');
      return new Response('ok');
    });

    const entry = auditLabelForEntrypoint('preview_origin');
    expect(entry).not.toBeNull();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe(entry!.action);
    expect(auditRows[0]?.metadata).toMatchObject({ http: 'GET preview_origin', entrypoint: 'preview_origin' });
  });
});

/**
 * A request can match two endpoints: `GET …/gateway/logs/facets` and
 * `GET …/gateway/logs/:logId`. Hono runs the first one registered. The row
 * names that one too, whether it answered or a middleware refused the request
 * before it ran. It used to name the last match, so every facets request was
 * written as a log read.
 */
describe('a request two routes match is written under the route Hono runs', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const LOG = '22222222-2222-4222-8222-222222222222';
  const FACETS = '/v1/projects/:projectId/gateway/logs/facets';
  const LOG_READ = '/v1/projects/:projectId/gateway/logs/:logId';

  beforeEach(() => {
    auditRows = [];
  });

  test('the facets route and the log route have different labels', () => {
    expect(label('GET', FACETS).action).not.toBe(label('GET', LOG_READ).action);
  });

  test('a facets request is written as the facets read, not as a log read', async () => {
    const res = await projectsApp().request(`/v1/projects/${PROJECT}/gateway/logs/facets`, {
      headers: { authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe(label('GET', FACETS).action);
    expect(auditRows[0]?.metadata).toMatchObject({ http: `GET ${FACETS}`, path: FACETS });
  });

  test('a facets request the auth middleware refused is still written as the facets read', async () => {
    const res = await projectsApp().request(`/v1/projects/${PROJECT}/gateway/logs/facets`);

    expect(res.status).toBe(401);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: label('GET', FACETS).action,
      outcome: 'denied',
      httpStatus: 401,
    });
    expect(auditRows[0]?.metadata).toMatchObject({ http: `GET ${FACETS}`, path: FACETS });
  });

  test('a log id request is written as the log read', async () => {
    const res = await projectsApp().request(`/v1/projects/${PROJECT}/gateway/logs/${LOG}`, {
      headers: { authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(auditRows[0]?.action).toBe(label('GET', LOG_READ).action);
    expect(auditRows[0]?.metadata).toMatchObject({ http: `GET ${LOG_READ}`, path: LOG_READ });
  });

  test('a log id request the auth middleware refused is written as the log read', async () => {
    const res = await projectsApp().request(`/v1/projects/${PROJECT}/gateway/logs/${LOG}`);

    expect(res.status).toBe(401);
    expect(auditRows[0]?.action).toBe(label('GET', LOG_READ).action);
  });
});

/**
 * The same rule for every overlap in the API's route manifest: a route that
 * another route of its method also matches (`GET /v1/projects/quota` and
 * `GET /v1/projects/:projectId`). The real router registers the more specific
 * route first, so Hono runs it. This app registers the manifest in that order:
 * a static segment before a parameter, a parameter before a wildcard. Each
 * overlapping route is requested twice: once it answers, once a middleware
 * refuses the request first. Both rows must name it.
 */
describe('every overlapping route in the manifest is written under itself', () => {
  type ManifestRoute = { method: string; path: string };
  const manifest = JSON.parse(
    readFileSync(new URL('../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
  ) as { routes: ManifestRoute[] };

  const segments = (path: string) => path.split('/').filter(Boolean);
  const rank = (segment: string) => (segment === '*' ? 2 : segment.startsWith(':') ? 1 : 0);
  function bySpecificity(a: ManifestRoute, b: ManifestRoute): number {
    const left = segments(a.path).map(rank);
    const right = segments(b.path).map(rank);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      if (left[i] !== right[i]) return (left[i] ?? -1) - (right[i] ?? -1);
    }
    return 0;
  }
  /** A request path for a route template: every parameter and wildcard filled. */
  const requestPath = (path: string) =>
    `/${segments(path)
      .map((segment) => (segment === '*' ? 'any/rest' : segment.startsWith(':') ? 'p-1' : segment))
      .join('/')}`;

  let matched: ManifestRoute[] = [];
  function manifestApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', auditApiRequest);
    // A signed-in caller, so the anonymous-row budget never drops a row.
    app.use('*', async (c, next) => {
      matched = matchedRoutes(c).filter((route) => route.path !== '/*');
      c.set('userId', '33333333-3333-4333-8333-333333333333');
      if (c.req.header('x-refuse')) return c.json({ error: 'forbidden' }, 403);
      await next();
    });
    for (const route of [...manifest.routes].sort(bySpecificity)) {
      if (route.method === 'ALL') app.all(route.path, (c) => c.text('ok'));
      else app.on(route.method, route.path, (c) => c.text('ok'));
    }
    return app;
  }

  /** The route the request's row names, or a note when it wrote no row or more than one. */
  async function rowPath(app: Hono<AppEnv>, route: ManifestRoute, refuse: boolean) {
    auditRows = [];
    await app.request(requestPath(route.path), {
      method: route.method === 'ALL' ? 'GET' : route.method,
      headers: refuse ? { 'x-refuse': '1' } : {},
    });
    if (auditRows.length !== 1) return `${auditRows.length} rows`;
    return (auditRows[0]?.metadata as { path?: string } | undefined)?.path;
  }

  test('a route that another route of its method also matches is the row route, served or refused', async () => {
    const app = manifestApp();
    let overlaps = 0;
    const wrong: string[] = [];
    for (const route of manifest.routes) {
      const served = await rowPath(app, route, false);
      if (!matched.some((m) => m.method === route.method && m.path !== route.path)) continue;
      overlaps += 1;
      const refused = await rowPath(app, route, true);
      if (served !== route.path) wrong.push(`${route.method} ${route.path}: served row names ${served}`);
      if (refused !== route.path) wrong.push(`${route.method} ${route.path}: refused row names ${refused}`);
    }
    // 23 on 2026-11-04: 11 method routes (`GET …/logs/facets`) and 12 `app.all` catch-alls.
    expect(overlaps).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

/**
 * A handler that writes its own event for the request (`iam.group.create`
 * with the created group in `after`) used to leave two rows with the same
 * action: its event and the request row. The event is the richer one, so it
 * becomes the request's row and carries the request's IP and user agent.
 */
describe('a handler event with the route action is the request row', () => {
  beforeEach(() => {
    auditRows = [];
  });

  const request = (headers: Record<string, string>) =>
    projectsApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
        'user-agent': 'kortix-cli/1.0',
        'x-forwarded-for': '203.0.113.9',
        ...headers,
      },
    });

  test('a successful request writes one row: the event, with the request IP and user agent', async () => {
    const res = await request({ 'x-record': 'same' });

    expect(res.status).toBe(201);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: label('POST', '/v1/projects').action,
      after: { name: 'Demo' },
      ip: '203.0.113.9',
      userAgent: 'kortix-cli/1.0',
    });
  });

  test('an event with another action is a second row next to the request row', async () => {
    await request({ 'x-record': 'other' });

    expect(auditRows.map((row) => row.action).sort()).toEqual(
      [label('POST', '/v1/projects').action, 'project.repository.link'].sort(),
    );
  });

  test('a failed request keeps its request row, with the status, next to the event', async () => {
    const res = await request({ 'x-record': 'same', 'x-fail': '1' });

    expect(res.status).toBe(500);
    expect(auditRows).toHaveLength(2);
    expect(auditRows.find((row) => row.httpStatus === 500)).toMatchObject({
      action: label('POST', '/v1/projects').action,
      outcome: 'failure',
    });
  });
});

/**
 * A handler that records an event only when something changed (the secret
 * strategy handler records `secret.strategy.changed` only for a real change)
 * lists that event on its route's label. A request that changed something is
 * then one row, the event; a no-op request is its own row under the request
 * label, which never claims a change that did not happen (SEC-8).
 */
describe("a route label's events stand in for the request row", () => {
  beforeEach(() => {
    auditRows = [];
  });

  const strategyRoute = '/v1/projects/:projectId/secrets/:identifier/strategy';

  function strategyApp(): Hono {
    const app = new Hono();
    app.use('*', auditApiRequest);
    app.put(strategyRoute, async (c) => {
      if (c.req.header('x-changed')) {
        await recordAuditEvent({
          action: 'secret.strategy.changed',
          resourceType: 'project_secret',
          resourceId: 's1',
        });
      }
      return c.json({ strategy: 'runtime' });
    });
    return app;
  }

  test('the label names the request and lists the event its handler records', () => {
    const strategy = label('PUT', strategyRoute);
    expect(strategy.action).not.toBe('secret.strategy.changed');
    expect(strategy.events).toContain('secret.strategy.changed');
  });

  test('a request that changed the strategy is one row: the event', async () => {
    await strategyApp().request('/v1/projects/p1/secrets/API_KEY/strategy', {
      method: 'PUT',
      headers: { 'x-changed': '1' },
    });

    expect(auditRows.map((row) => row.action)).toEqual(['secret.strategy.changed']);
  });

  test('a no-op request is its own row, under the request label', async () => {
    await strategyApp().request('/v1/projects/p1/secrets/API_KEY/strategy', { method: 'PUT' });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe(label('PUT', strategyRoute).action);
    expect(auditRows[0]?.metadata).toMatchObject({ http: `PUT ${strategyRoute}` });
  });
});
