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
          returning: async () => [
            {
              eventId: 'audit_test',
              occurredAt: new Date('2026-01-01T00:00:00Z'),
              ...values,
            },
          ],
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

const { auditApiRequest, recordAuditEvent } = await import('../shared/audit');

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
      action: 'POST /v1/projects/:projectId/sessions/:sessionId/messages',
      resourceType: 'project_session',
      resourceId: 'session-1',
      userAgent: 'kortix-cli/dev',
    });
    expect(auditRows[0]?.durationMs).toBeNumber();
  });

  test('keeps client-reported CLI provenance separate from authoritative provenance', async () => {
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
      source: 'api',
      authoritativeSource: 'api',
      clientReportedSource: 'cli',
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

    const res = await app.request('/v1/projects/00000000-0000-4000-a000-000000000201/detail', {
      headers: { 'X-Kortix-Client': 'forged-source' },
    });

    expect(res.status).toBe(200);
    expect(auditRows[0]).toMatchObject({
      source: 'api',
      authoritativeSource: 'api',
      clientReportedSource: 'forged-source',
    });
  });

  test('rejects credential-shaped client source labels', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.get('/v1/projects/:projectId/detail', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'pat');
      return c.json({ ok: true });
    });

    const res = await app.request('/v1/projects/00000000-0000-4000-a000-000000000201/detail', {
      headers: { 'X-Kortix-Client': 'kortix_pat_private-credential' },
    });

    expect(res.status).toBe(200);
    expect(auditRows[0]?.clientReportedSource).toBeNull();
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
      source: 'human',
      authoritativeSource: 'human',
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

    const res = await app.request('/v1/accounts/00000000-0000-4000-a000-000000000101/projects');

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'GET /v1/accounts/:accountId/projects',
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
      path: '/v1/projects/:projectId/secrets',
    });
    expect(JSON.stringify(auditRows[0])).not.toContain('query-secret');
    expect(JSON.stringify(auditRows[0])).not.toContain('body-secret');
    expect(JSON.stringify(auditRows[0])).not.toContain('private prompt');
    expect(JSON.stringify(auditRows[0])).not.toContain('private credential');
  });

  test('stores the matched route template instead of bearer values in path segments', async () => {
    const app = new Hono();
    app.use('/v1/*', auditApiRequest);
    app.get('/v1/approval-links/:token', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      (c as any).set('authType', 'supabase');
      return c.json({ ok: true });
    });

    const res = await app.request('/v1/approval-links/private-bearer-capability');

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'GET /v1/approval-links/:token',
      metadata: { method: 'GET', path: '/v1/approval-links/:token' },
    });
    expect(JSON.stringify(auditRows[0])).not.toContain('private-bearer-capability');
  });

  test('redacts content fields and fingerprints raw errors at the central write boundary', async () => {
    await recordAuditEvent({
      accountId: '00000000-0000-4000-a000-000000000101',
      action: 'test.privacy',
      resourceType: 'test',
      inputSummary: {
        prompt: 'private prompt body',
        command: 'curl https://private.example.test',
        note: 'x'.repeat(513),
        request: { authorization: 'Bearer private-input-credential' },
        count: 1,
      },
      outputSummary: {
        output: 'raw unrestricted output',
        response: 'unrestricted provider response',
        status: 'failed',
      },
      errorMessage: 'provider echoed sk-private-error-credential',
      before: {
        url: 'https://user:private-password@example.test/private/bearer/path?trace=private#secret',
      },
      metadata: {
        access_token: 'private-access-token',
        environment: { PRIVATE_KEY: 'private-environment-value' },
        safe_reason: 'provider_failed',
      },
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      inputSummary: {
        prompt: '[REDACTED]',
        command: '[REDACTED]',
        note: { redacted: true, length: 513 },
        request: { authorization: '[REDACTED]' },
        count: 1,
      },
      outputSummary: {
        output: '[REDACTED]',
        response: '[REDACTED]',
        status: 'failed',
      },
      errorMessage: null,
      metadata: {
        access_token: '[REDACTED]',
        environment: '[REDACTED]',
        safe_reason: 'provider_failed',
      },
    });
    expect(auditRows[0]?.inputSha256).toHaveLength(64);
    expect(auditRows[0]?.outputSha256).toHaveLength(64);
    expect(auditRows[0]?.before).toMatchObject({
      url: { origin: 'https://example.test' },
    });
    expect(
      ((auditRows[0]?.before as { url?: { sha256?: string } })?.url?.sha256 ?? '').length,
    ).toBe(64);
    const persisted = JSON.stringify(auditRows[0]);
    expect(persisted).not.toContain('private prompt body');
    expect(persisted).not.toContain('curl https://private.example.test');
    expect(persisted).not.toContain('private-input-credential');
    expect(persisted).not.toContain('raw unrestricted output');
    expect(persisted).not.toContain('unrestricted provider response');
    expect(persisted).not.toContain('private-error-credential');
    expect(persisted).not.toContain('private-access-token');
    expect(persisted).not.toContain('private-environment-value');
    expect(persisted).not.toContain('x'.repeat(513));
    expect(persisted).not.toContain('private-password');
    expect(persisted).not.toContain('/private/bearer/path');
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
      source: 'api',
      authoritativeSource: 'api',
      clientReportedSource: 'cli',
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
