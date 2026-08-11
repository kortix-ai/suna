/**
 * POST /v1/connectors/webhook/pipedream — payload parsing + result mapping.
 *
 * Regression: every real Pipedream Connect webhook was answered 400 "missing
 * external_user_id". The handler read `body.external_user_id`, but a real
 * CONNECTION_SUCCESS payload nests the id at `account.external_id`:
 *
 *   { event: "CONNECTION_SUCCESS", connect_token, environment,
 *     connect_session_id, account: { id, name, external_id, app: {…}, … } }
 *
 * so no connect that went through the hosted page ever persisted a credential.
 * CONNECTION_ERROR carries no `account` at all and nothing to finalize.
 *
 * These tests drive the REAL connector router with a stub `pipedreamWebhook`
 * dep, so they assert the route's parsing and status mapping without a DB.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
  createConnectorRouter,
} from '../connectors/router';

const EXT_USER_ID = 'proj-1:smartlead';

interface WebhookCall {
  extUserId: string;
  sig: string | null;
}

function buildApp(result: { ok: boolean; connected: boolean }) {
  const calls: WebhookCall[] = [];
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async () => null as unknown as ConnectorPrincipal,
    resolveWorkspacePrincipal: async () => null as unknown as ConnectorPrincipal,
    makeGatewayDeps: (() => ({}) as unknown) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async () => null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    pipedreamWebhook: async (extUserId, sig) => {
      calls.push({ extUserId, sig });
      return result;
    },
  };
  const app = createConnectorRouter(deps);
  return {
    calls,
    post: (body: unknown, query = '?sig=abc') =>
      app.fetch(
        new Request(`http://x/webhook/pipedream${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
  };
}

const CONNECTION_SUCCESS = {
  event: 'CONNECTION_SUCCESS',
  connect_token: 'ctok_123',
  environment: 'production',
  connect_session_id: 'cs_1',
  account: {
    id: 'apn_abc123',
    name: 'Smartlead',
    external_id: EXT_USER_ID,
    healthy: true,
    dead: false,
    app: { id: 'app_1', name_slug: 'smartlead' },
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
  },
};

describe('POST /webhook/pipedream — external user id parsing', () => {
  test('real CONNECTION_SUCCESS shape: reads account.external_id → 200', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    const res = await post(CONNECTION_SUCCESS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ extUserId: EXT_USER_ID, sig: 'abc' }]);
  });

  test('legacy top-level external_user_id still works → 200', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    const res = await post({ event: 'CONNECTION_SUCCESS', external_user_id: EXT_USER_ID });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ extUserId: EXT_USER_ID, sig: 'abc' }]);
  });

  test('top-level id wins when both shapes are present', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    await post({ ...CONNECTION_SUCCESS, external_user_id: 'proj-1:legacy' });
    expect(calls[0]?.extUserId).toBe('proj-1:legacy');
  });

  test('CONNECTION_ERROR is acked 200 as ignored and never finalizes', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    const res = await post({
      event: 'CONNECTION_ERROR',
      connect_token: 'ctok_123',
      environment: 'production',
      connect_session_id: 'cs_1',
      error: 'user cancelled',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(calls).toHaveLength(0);
  });

  test('a payload with no usable id → 400', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    const res = await post({ event: 'CONNECTION_SUCCESS', account: { id: 'apn_1' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing external_user_id');
    expect(calls).toHaveLength(0);
  });

  test('a non-string nested id is not accepted → 400', async () => {
    const { post } = buildApp({ ok: true, connected: true });
    const res = await post({ event: 'CONNECTION_SUCCESS', account: { external_id: 42 } });
    expect(res.status).toBe(400);
  });
});

describe('POST /webhook/pipedream — result mapping', () => {
  test('bad signature → 401', async () => {
    const { post } = buildApp({ ok: false, connected: false });
    const res = await post(CONNECTION_SUCCESS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid signature');
  });

  test('signed but no account visible yet → 503, never a silent 200', async () => {
    const { post } = buildApp({ ok: true, connected: false });
    const res = await post(CONNECTION_SUCCESS);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('account not yet visible');
  });

  test('missing sig query is passed through as null', async () => {
    const { calls, post } = buildApp({ ok: true, connected: true });
    await post(CONNECTION_SUCCESS, '');
    expect(calls[0]?.sig).toBeNull();
  });
});
