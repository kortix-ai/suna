import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

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

const { auditStateChangingRequest } = await import('../shared/audit');

describe('audit event middleware', () => {
  beforeEach(() => {
    auditRows = [];
  });

  test('records successful state-changing /v1 requests with actor and account context', async () => {
    const app = new Hono();
    app.use('/v1/*', auditStateChangingRequest);
    app.post('/v1/projects/:projectId/secrets', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      return c.json({ ok: true });
    });

    const res = await app.request('/v1/projects/project-1/secrets', {
      method: 'POST',
      headers: { 'User-Agent': 'audit-test' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    await Bun.sleep(0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      accountId: '00000000-0000-4000-a000-000000000101',
      actorUserId: '00000000-0000-4000-a000-000000000001',
      action: 'POST /v1/projects/project-1/secrets',
      resourceType: 'project',
      resourceId: 'project-1',
      userAgent: 'audit-test',
      metadata: { status: 200 },
    });
  });

  test('does not record failed mutations', async () => {
    const app = new Hono();
    app.use('/v1/*', auditStateChangingRequest);
    app.post('/v1/projects/:projectId/secrets', async (c) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      (c as any).set('accountId', '00000000-0000-4000-a000-000000000101');
      return c.json({ error: 'bad input' }, 400);
    });

    const res = await app.request('/v1/projects/project-1/secrets', { method: 'POST' });

    expect(res.status).toBe(400);
    await Bun.sleep(0);
    expect(auditRows).toHaveLength(0);
  });
});
