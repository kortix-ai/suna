import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { runWithContext, setContextField } from '../lib/request-context';

let auditRows: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        auditRows.push(values);
        return {
          returning: async () => [{
            eventId: 'audit_test',
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            ...values,
          }],
        };
      },
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
      };
      return chain;
    },
  },
}));

const { auditApiRequest } = await import('../shared/audit');

describe('audit event middleware', () => {
  beforeEach(() => {
    auditRows = [];
  });

  test('records a successful API mutation with an authoritative source', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.post('/v1/projects/:projectId/sessions/:sessionId/messages', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'pat');
      (c as any).set('sessionId', c.req.param('sessionId'));
      return c.json({ ok: true });
    });

    const res = await app.request(
      '/v1/projects/00000000-0000-4000-a000-000000000201/sessions/session-1/messages',
      {
      method: 'POST',
      headers: { 'User-Agent': 'kortix-cli/dev', 'X-Kortix-Client': 'cli' },
      body: '{}',
      },
    );

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      accountId: '00000000-0000-4000-a000-000000000101',
      projectId: '00000000-0000-4000-a000-000000000201',
      sessionId: 'session-1',
      actorUserId: '00000000-0000-4000-a000-000000000001',
      actorType: 'agent',
      source: 'agent',
      outcome: 'success',
      httpStatus: 200,
      action:
        'POST /v1/projects/00000000-0000-4000-a000-000000000201/sessions/session-1/messages',
      resourceType: 'project_session',
      resourceId: 'session-1',
      userAgent: 'kortix-cli/dev',
    });
    expect(auditRows[0]?.durationMs).toBeNumber();
  });

  test('records an authenticated CLI request as CLI traffic', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.patch('/v1/projects/:projectId/secrets/:identifier/strategy', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'pat');
      return c.json({ ok: true });
    });

    const res = await app.request(
      '/v1/projects/00000000-0000-4000-a000-000000000201/secrets/demo/strategy',
      { method: 'PATCH', headers: { 'X-Kortix-Client': 'cli' }, body: '{}' },
    );

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorType: 'human',
      source: 'cli',
      outcome: 'success',
    });
  });

  test('does not accept an unknown client source label', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.get('/v1/projects/:projectId/detail', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'pat');
      return c.json({ ok: true });
    });

    const res = await app.request(
      '/v1/projects/00000000-0000-4000-a000-000000000201/detail',
      { headers: { 'X-Kortix-Client': 'forged-source' } },
    );

    expect(res.status).toBe(200);
    expect(auditRows[0]).toMatchObject({ source: 'api' });
  });

  test('records failed mutations with a failure outcome', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.post('/v1/projects/:projectId/secrets', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'supabase');
      return c.json({ error: 'bad input' }, 400);
    });

    const res = await app.request('/v1/projects/project-1/secrets', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorType: 'human',
      source: 'web',
      outcome: 'failure',
      httpStatus: 400,
    });
  });

  test('records authenticated reads', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.get('/v1/accounts/:accountId/projects', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', c.req.param('accountId'));
      (c as any).set('authType', 'supabase');
      return c.json({ projects: [] });
    });

    const res = await app.request(
      '/v1/accounts/00000000-0000-4000-a000-000000000101/projects',
    );

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'GET /v1/accounts/00000000-0000-4000-a000-000000000101/projects',
      outcome: 'success',
      httpStatus: 200,
    });
  });

  test('does not copy request bodies or query values into the central event', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.post('/v1/projects/:projectId/secrets', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'supabase');
      return c.json({ ok: true });
    });

    const res = await app.request(
      '/v1/projects/00000000-0000-4000-a000-000000000201/secrets?token=query-secret',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'body-secret',
          prompt: 'private prompt',
          connector_args: { authorization: 'private credential' },
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toEqual({
      method: 'POST',
      path: '/v1/projects/00000000-0000-4000-a000-000000000201/secrets',
    });
    expect(JSON.stringify(auditRows[0])).not.toContain('query-secret');
    expect(JSON.stringify(auditRows[0])).not.toContain('body-secret');
    expect(JSON.stringify(auditRows[0])).not.toContain('private prompt');
    expect(JSON.stringify(auditRows[0])).not.toContain('private credential');
  });

  test('records mounted project routes from the shared request context', async () => {
    const app = new Hono();
    app.use('/v1/*', async (c, next) => {
      await runWithContext(c.req.method, c.req.path, next);
    });
    app.use('/v1/*', auditApiRequest);
    app.post('/v1/projects/provision', (c) => {
      setContextField('userId', '00000000-0000-4000-a000-000000000001');
      setContextField('accountId', '00000000-0000-4000-a000-000000000101');
      setContextField('projectId', '00000000-0000-4000-a000-000000000201');
      return c.json({ ok: true }, 201);
    });

    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: {
        'X-Kortix-Client': 'cli',
        'X-Correlation-Id': 'project-create-1',
      },
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      accountId: '00000000-0000-4000-a000-000000000101',
      projectId: '00000000-0000-4000-a000-000000000201',
      actorUserId: '00000000-0000-4000-a000-000000000001',
      actorType: 'human',
      source: 'cli',
      outcome: 'success',
      httpStatus: 201,
      correlationId: 'project-create-1',
    });
  });

  test('discards non-UUID request scope before the database write', async () => {
    const app = new Hono();
    app.use('/v1/*', async (c, next) => {
      await runWithContext(c.req.method, c.req.path, async () => {
        setContextField('userId', '00000000-0000-4000-a000-000000000001');
        setContextField('accountId', '00000000-0000-4000-a000-000000000101');
        setContextField('projectId', 'provision');
        await next();
      });
    });
    app.use('/v1/*', auditApiRequest);
    app.post('/v1/projects/provision', (c) => c.json({ error: 'name is required' }, 400));

    const res = await app.request('/v1/projects/provision', {
      method: 'POST',
      headers: { 'X-Correlation-Id': 'invalid-scope-1' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      accountId: '00000000-0000-4000-a000-000000000101',
      projectId: null,
      actorUserId: '00000000-0000-4000-a000-000000000001',
      outcome: 'failure',
      correlationId: 'invalid-scope-1',
    });
  });
});
