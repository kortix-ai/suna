/**
 * Router-level coverage for `account_required` — THE RULE: an unnamed (or
 * `me`/`project`-shorthand) connector call uses an account implicitly ONLY
 * when exactly one account is reachable, OR a human has deliberately pinned a
 * default. Several reachable accounts, none named, none pinned → the call is
 * DENIED with `account_required`, never a silent guess (mail from the wrong
 * mailbox).
 *
 * `unit-connector-gateway.test.ts` pins that `handleCall` passes the reason
 * through verbatim. This file pins the HTTP-visible contract: the denial
 * body's exact shape (`available_accounts`, `default_account: null`, the
 * hint), the 403 status, and the `GET .../accounts` route's new
 * `default_account` field — all with fake deps, no database.
 */
import { describe, expect, test } from 'bun:test';
import type { GatewayDeps } from '../connectors/gateway';
import {
  createConnectorRouter,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
} from '../connectors/router';

const PROJECT = 'proj-1';
const ALICE = 'user-alice';

const ACCOUNTS = [
  { connection_id: 'conn-work', label: 'Work', owner_type: 'project', is_default: false },
  { connection_id: 'conn-sales', label: 'Sales', owner_type: 'project', is_default: false },
];

function buildRouter(opts: {
  explainMissingConnector: GatewayDeps['explainMissingConnector'];
  listConnectorAccounts?: ConnectorRouterDeps['listConnectorAccounts'];
}): ReturnType<typeof createConnectorRouter> {
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async (c) => {
      const u = c.req.header('x-test-user');
      return u
        ? ({
            userId: u,
            accountId: 'acct-1',
            projectId: PROJECT,
            sessionId: null,
            subject: { userId: u, groupIds: [] },
          } as ConnectorPrincipal)
        : null;
    },
    resolveProjectPrincipal: async (c) => {
      const u = c.req.header('x-test-user');
      return u
        ? ({
            userId: u,
            accountId: 'acct-1',
            projectId: PROJECT,
            sessionId: null,
            subject: { userId: u, groupIds: [] },
          } as ConnectorPrincipal)
        : null;
    },
    makeGatewayDeps: (() =>
      ({
        loadConnectorBySlug: async () => null,
        explainMissingConnector: opts.explainMissingConnector,
        loadAction: async () => null,
        resolveCredential: async () => null,
      }) as unknown as GatewayDeps) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async () => null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    discoverConnectorAuth: async () => {
      throw new Error('not used');
    },
    createConnector: async () => ({ ok: true, sync: { synced: 0, errors: [] } }),
    listConnectorAccounts: opts.listConnectorAccounts ?? (async () => ACCOUNTS),
  };
  return createConnectorRouter(deps);
}

describe('/call → account_required', () => {
  test('several accounts, none named → 403 account_required with every available account', async () => {
    const app = buildRouter({ explainMissingConnector: async () => 'account_required' });
    const res = await app.fetch(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'x-test-user': ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ connector: 'gmail', action: 'send_message', args: {} }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'account_required',
      connector: 'gmail',
      action: 'send_message',
      available_accounts: ['Work', 'Sales'],
      default_account: null,
    });
    expect(String(body.hint)).toContain('account:<label|id|me|project>');
  });

  test('account_required lists accounts even though the caller named none — unlike connector_not_connected', async () => {
    // connector_not_connected only lists accounts when the caller NAMED a
    // wrong one (see router.ts). account_required is the opposite case — no
    // name at all — and must still list them, or the retry has nothing to go on.
    const app = buildRouter({ explainMissingConnector: async () => 'account_required' });
    const res = await app.fetch(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'x-test-user': ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ connector: 'gmail', action: 'send_message' }),
      }),
    );
    const body = await res.json();
    expect(body.available_accounts).toEqual(['Work', 'Sales']);
  });

  test('connector_not_connected with no named account still lists nothing (unchanged)', async () => {
    const app = buildRouter({ explainMissingConnector: async () => 'connector_not_connected' });
    const res = await app.fetch(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'x-test-user': ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ connector: 'gmail', action: 'send_message' }),
      }),
    );
    const body = await res.json();
    expect(body.reason).toBe('connector_not_connected');
    expect(body.available_accounts).toBeUndefined();
  });
});

describe('GET /projects/:id/connectors/:slug/accounts', () => {
  test('default_account is the pinned label when exactly one account is pinned', async () => {
    const app = buildRouter({
      explainMissingConnector: async () => 'connector_not_connected',
      listConnectorAccounts: async () => [
        { connection_id: 'conn-work', label: 'Work', owner_type: 'project', is_default: true },
        { connection_id: 'conn-sales', label: 'Sales', owner_type: 'project', is_default: false },
      ],
    });
    const res = await app.fetch(
      new Request(`http://x/projects/${PROJECT}/connectors/gmail/accounts`, {
        headers: { 'x-test-user': ALICE },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connector).toBe('gmail');
    expect(body.default_account).toBe('Work');
    expect(body.accounts).toHaveLength(2);
  });

  test('default_account is null when nothing is pinned', async () => {
    const app = buildRouter({
      explainMissingConnector: async () => 'connector_not_connected',
      listConnectorAccounts: async () => ACCOUNTS,
    });
    const res = await app.fetch(
      new Request(`http://x/projects/${PROJECT}/connectors/gmail/accounts`, {
        headers: { 'x-test-user': ALICE },
      }),
    );
    const body = await res.json();
    expect(body.default_account).toBeNull();
  });
});
