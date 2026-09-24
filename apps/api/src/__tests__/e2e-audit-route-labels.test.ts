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
import {
  auditLabelForEntrypoint,
  auditLabelForRoute,
  UNMATCHED_ROUTE_LABEL,
} from '@kortix/shared/audit-labels';
import { Hono } from 'hono';

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

const { auditApiRequest, recordAuditEvent } = await import('../shared/audit');
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
