/**
 * Every anonymous row passes through the anonymous budget, including one that
 * lands in a tenant's log.
 *
 * An unauthenticated request to `/v1/projects/<uuid>` names a project, and the
 * emitter resolves that project's account so the probe is visible to its
 * owner. The account is not a principal: whoever knows a project id can send
 * that request at will, and each row can fan out to the account's audit
 * webhooks. Exempting it from the budget would give an outsider an unbounded
 * write path into any tenant's log.
 *
 * Its own file: the budget is read from the environment once, when
 * `shared/audit` is imported.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.KORTIX_AUDIT_ANONYMOUS_PER_SECOND = '2';

let auditRows: Array<Record<string, unknown>> = [];
let projectRows: Array<{ accountId: string }> = [];

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        auditRows.push(values);
        return { returning: async () => [{ eventId: 'audit_test', ...values }] };
      },
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => projectRows,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
      };
      return chain;
    },
  },
}));

const { auditApiRequest } = await import('../shared/audit');
const { __clearProjectAccountLookupForTests } = await import('../shared/project-account-lookup');

const USER = '00000000-0000-4000-a000-000000000001';
const ACCOUNT = '00000000-0000-4000-a000-000000000101';
const PROJECT = '00000000-0000-4000-a000-000000000201';

function projectApp(): Hono {
  const app = new Hono();
  app.use('*', auditApiRequest);
  app.get('/v1/projects/:projectId', (c) =>
    c.req.header('authorization') ? c.json({ ok: true }) : c.text('Unauthorized', 401),
  );
  return app;
}

function signedIn(): Hono {
  const app = new Hono();
  app.use('*', auditApiRequest);
  app.get('/v1/projects/:projectId', (c) => {
    (c as any).set('userId', USER);
    (c as any).set('accountId', ACCOUNT);
    return c.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  auditRows = [];
  projectRows = [{ accountId: ACCOUNT }];
  __clearProjectAccountLookupForTests();
});

describe('the anonymous budget covers rows attributed to a tenant', () => {
  test('a flood of unauthenticated probes at one project is capped per second', async () => {
    const app = projectApp();
    for (let i = 0; i < 6; i += 1) {
      const res = await app.request(`/v1/projects/${PROJECT}`);
      expect(res.status).toBe(401);
    }

    const probes = auditRows.filter((row) => row.actorType === 'anonymous');
    // A second boundary can fall inside the loop: at most two windows.
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.length).toBeLessThanOrEqual(4);
    expect(probes[0]).toMatchObject({ projectId: PROJECT, accountId: ACCOUNT, outcome: 'denied' });
  });

  test('a signed-in caller is never budgeted', async () => {
    const app = signedIn();
    for (let i = 0; i < 6; i += 1) await app.request(`/v1/projects/${PROJECT}`);

    expect(auditRows).toHaveLength(6);
    expect(auditRows.every((row) => row.actorType === 'human')).toBe(true);
  });
});
