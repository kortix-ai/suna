/**
 * The audit boundary at the server edge.
 *
 * `Bun.serve.fetch` dispatches preview subdomains, deployed-app origins and
 * WebSocket upgrades BEFORE Hono sees the request. None of them had a row or
 * a request context. `runInboundAudit` wraps the whole dispatcher, so every
 * entrypoint — including Hono — is written exactly once.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let auditRows: Array<Record<string, unknown>> = [];

function captured(values: Record<string, unknown> | Array<Record<string, unknown>>) {
  for (const row of Array.isArray(values) ? values : [values]) auditRows.push(row);
  return {
    returning: async () => [{ eventId: 'audit_test' }],
    onConflictDoNothing: async () => undefined,
  };
}

mock.module('./db', () => ({
  db: {
    insert: () => ({ values: captured }),
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

const { runInboundAudit } = await import('./audit-edge');
const { auditApiRequest, flushAuditEvents } = await import('./audit');
const { bindAuditPrincipal, setInboundAuditEntrypoint } = await import('./audit-scope');

const USER = '00000000-0000-4000-a000-000000000001';
const ACCOUNT = '00000000-0000-4000-a000-000000000101';

function inbound(path: string, init: RequestInit = {}): [Request, URL] {
  const url = new URL(`https://api.test${path}`);
  return [new Request(url, init), url];
}

describe('every entrypoint is written exactly once', () => {
  beforeEach(() => {
    auditRows = [];
  });

  test('a request dispatched outside Hono is written with the class its dispatcher set', async () => {
    const [req, url] = inbound('/', { headers: { 'User-Agent': 'Mozilla/5.0' } });

    const res = await runInboundAudit(req, url, async () => {
      setInboundAuditEntrypoint('preview_origin', 'preview_origin');
      bindAuditPrincipal({ actorUserId: USER, accountId: ACCOUNT, actorType: 'human' });
      return new Response('<html></html>', { status: 200 });
    });

    expect(res?.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorUserId: USER,
      accountId: ACCOUNT,
      actorType: 'human',
      action: 'GET preview_origin',
      resourceType: 'sandbox_preview_origin',
      httpStatus: 200,
      userAgent: 'Mozilla/5.0',
    });
    expect(auditRows[0]?.metadata).toMatchObject({ entrypoint: 'preview_origin' });
  });

  test('a WebSocket upgrade is written as a 101', async () => {
    const [req, url] = inbound('/v1/p/sbx/8000/kortix/pty/abc/connect', {
      headers: { upgrade: 'websocket' },
    });

    const res = await runInboundAudit(req, url, async () => {
      setInboundAuditEntrypoint('ws_upgrade', 'ws:/v1/p/:sandboxId/:port/*');
      bindAuditPrincipal({ actorUserId: USER, accountId: ACCOUNT, actorType: 'human' });
      return undefined; // server.upgrade() took the socket
    });

    expect(res).toBeUndefined();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'GET ws:/v1/p/:sandboxId/:port/*',
      resourceType: 'websocket',
      httpStatus: 101,
      outcome: 'success',
    });
  });

  test('a refused upgrade is written with its refusal', async () => {
    const [req, url] = inbound('/v1/p/sbx/8000/kortix/pty/abc/connect');

    await runInboundAudit(req, url, async () => {
      setInboundAuditEntrypoint('ws_upgrade', 'ws:/v1/p/:sandboxId/:port/*');
      return new Response('{"error":"unauthorized"}', { status: 401 });
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ actorType: 'anonymous', outcome: 'denied', httpStatus: 401 });
  });

  test('a request dispatched into Hono is written once, with the status Hono saw', async () => {
    const app = new Hono();
    app.use('*', auditApiRequest);
    app.post('/v1/projects/:projectId/secrets', (c) => {
      (c as any).set('userId', USER);
      (c as any).set('accountId', ACCOUNT);
      (c as any).set('authType', 'supabase');
      return c.json({ error: 'upstream' }, 502);
    });
    const [req, url] = inbound('/v1/projects/00000000-0000-4000-a000-000000000201/secrets', {
      method: 'POST',
    });

    // The wire rewrite that turns 502 into 503 sits outside the audit middleware.
    const res = await runInboundAudit(req, url, async () => {
      const inner = await app.fetch(req);
      return new Response(inner.body, { status: inner.status === 502 ? 503 : inner.status });
    });

    expect(res?.status).toBe(503);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'POST /v1/projects/:projectId/secrets',
      actorUserId: USER,
      actorType: 'human',
      httpStatus: 502,
    });
  });

  test('a dispatcher that throws is written as a 500, and the error still propagates', async () => {
    const [req, url] = inbound('/v1/p/sbx/3000/');

    await expect(
      runInboundAudit(req, url, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ httpStatus: 500, outcome: 'failure' });
  });

  test('probe traffic never opens a scope', async () => {
    const [req, url] = inbound('/health/live');
    await runInboundAudit(req, url, async () => new Response('ok'));
    expect(auditRows).toHaveLength(0);
  });
});

describe('deployed apps', () => {
  beforeEach(() => {
    auditRows = [];
  });

  test('anonymous traffic to a deployed app is the customer’s end users, not written', async () => {
    const [req, url] = inbound('/');
    await runInboundAudit(req, url, async () => {
      setInboundAuditEntrypoint('app_origin', 'app_origin');
      return new Response('app');
    });
    expect(auditRows).toHaveLength(0);
  });

  test('a signed-in viewer of a private app is written', async () => {
    const [req, url] = inbound('/');
    await runInboundAudit(req, url, async () => {
      setInboundAuditEntrypoint('app_origin', 'app_origin');
      bindAuditPrincipal({ actorUserId: USER, accountId: ACCOUNT, actorType: 'human' });
      return new Response('app');
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'GET app_origin', resourceType: 'app' });
  });
});

describe('the response is not held for the audit write', () => {
  const previous = process.env.KORTIX_AUDIT_SYNC;
  beforeEach(() => {
    auditRows = [];
    process.env.KORTIX_AUDIT_SYNC = '0';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.KORTIX_AUDIT_SYNC;
    else process.env.KORTIX_AUDIT_SYNC = previous;
  });

  test('a flush waits for rows the edge was still building', async () => {
    const [req, url] = inbound('/v1/git/p.git/info/refs');

    await runInboundAudit(req, url, async () => {
      bindAuditPrincipal({ actorUserId: USER, accountId: ACCOUNT, actorType: 'human' });
      return new Response('refs');
    });
    await flushAuditEvents();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ actorUserId: USER, httpStatus: 200 });
  });
});
