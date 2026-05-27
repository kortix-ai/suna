/**
 * Gateway orchestrator — full decision+execution path with fakes. Access lives on
 * the connector (shareScope + grants); the credential is resolved by mode
 * (shared vs per_user) via resolveCredential. Covers success, not-found, sharing
 * denial, needs-auth, audit, pipedream, and policy enforcement.
 */
import { describe, expect, test } from 'bun:test';
import {
  handleCall,
  type CallInput,
  type ExecutionRecord,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
} from '../executor/gateway';
import type { DefaultMode, Policy } from '../executor/policy';

const ALICE = 'user-alice';

const STRIPE: GatewayConnector = {
  connectorId: 'conn-stripe',
  slug: 'stripe',
  provider: 'openapi',
  baseUrl: 'https://api.stripe.com',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  shareScope: 'project',
  grants: [],
  credentialMode: 'shared',
  enabled: true,
};

const CREATE_CHARGE: GatewayAction = {
  path: 'stripe.charges.create',
  relPath: 'charges.create',
  inputSchema: { type: 'object', properties: { amount: {} } },
  risk: 'write',
  binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: 'https://api.stripe.com' },
};

interface FakeOpts {
  connector?: GatewayConnector | null;
  action?: GatewayAction | null;
  secret?: string | null; // resolveCredential return
  policies?: Policy[];
  projectPolicies?: Policy[];
  defaultMode?: DefaultMode;
  enforcePolicies?: boolean;
  fetchStatus?: number;
  fetchBody?: string;
}

function makeDeps(o: FakeOpts = {}) {
  const records: ExecutionRecord[] = [];
  const fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const credentialCalls: Array<{ connectorId: string; userId: string | null }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => (o.connector === undefined ? STRIPE : o.connector),
    loadAction: async () => (o.action === undefined ? CREATE_CHARGE : o.action),
    resolveCredential: async (connectorId, userId) => {
      credentialCalls.push({ connectorId, userId });
      return o.secret === undefined ? 'sk_live_123' : o.secret;
    },
    loadPolicies: async () => o.policies ?? [],
    loadProjectPolicies: async () => o.projectPolicies ?? [],
    loadDefaultMode: async () => o.defaultMode ?? 'allow_all',
    enforcePolicies: o.enforcePolicies,
    recordExecution: async (r) => { records.push(r); },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, ...init });
      const status = o.fetchStatus ?? 200;
      return { status, ok: status >= 200 && status < 300, text: async () => o.fetchBody ?? '{"id":"ch_1"}' };
    },
  };
  return { deps, records, fetchCalls, credentialCalls };
}

const baseInput: CallInput = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: ALICE, groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: 'stripe',
  actionPath: 'charges.create',
  args: { amount: 500 },
};

describe('handleCall — happy path', () => {
  test('resolves shared credential, attaches auth, returns ok, audits', async () => {
    const { deps, records, fetchCalls, credentialCalls } = makeDeps();
    const res = await handleCall(deps, baseInput);
    expect(res).toEqual({ status: 'ok', data: { id: 'ch_1' }, risk: 'write' });
    expect(fetchCalls[0]!.headers.Authorization).toBe('Bearer sk_live_123');
    expect(credentialCalls[0]).toEqual({ connectorId: 'conn-stripe', userId: null }); // shared
    expect(records.at(-1)).toMatchObject({ status: 'ok', risk: 'write', actingUserId: ALICE });
  });

  test('per_user mode resolves the acting user\'s own credential', async () => {
    const { deps, credentialCalls } = makeDeps({ connector: { ...STRIPE, credentialMode: 'per_user' } });
    await handleCall(deps, baseInput);
    expect(credentialCalls[0]).toEqual({ connectorId: 'conn-stripe', userId: ALICE });
  });

  test('no-auth connector runs without a credential', async () => {
    const { deps, fetchCalls } = makeDeps({ connector: { ...STRIPE, hasAuth: false }, secret: null });
    const res = await handleCall(deps, baseInput);
    expect(res.status).toBe('ok');
    expect(fetchCalls[0]!.headers.Authorization).toBeUndefined();
  });
});

describe('handleCall — denials', () => {
  test('connector not found', async () => {
    const { deps } = makeDeps({ connector: null });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'connector_not_found' });
  });

  test('action not found', async () => {
    const { deps } = makeDeps({ action: null });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'action_not_found' });
  });

  test('not shared (restricted to another member) → denied, no upstream', async () => {
    const { deps, fetchCalls } = makeDeps({
      connector: { ...STRIPE, shareScope: 'restricted', grants: [{ principalType: 'member', principalId: 'someone-else' }] },
    });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'not_shared' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('shared via group membership', async () => {
    const { deps } = makeDeps({
      connector: { ...STRIPE, shareScope: 'restricted', grants: [{ principalType: 'group', principalId: 'g1' }] },
    });
    const res = await handleCall(deps, { ...baseInput, subject: { userId: ALICE, groupIds: ['g1'] } });
    expect(res.status).toBe('ok');
  });

  test('credential not set → needs_auth', async () => {
    const { deps } = makeDeps({ secret: null });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'needs_auth' });
  });
});

describe('handleCall — upstream + errors', () => {
  test('non-2xx upstream → error', async () => {
    const { deps } = makeDeps({ fetchStatus: 402, fetchBody: '{"error":"declined"}' });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'error', reason: 'upstream_402' });
  });

  test('thrown execution error is caught + audited', async () => {
    const { deps, records } = makeDeps();
    deps.fetchImpl = async () => { throw new Error('network down'); };
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'error', reason: 'network down' });
    expect(records.at(-1)).toMatchObject({ status: 'error' });
  });
});

describe('handleCall — pipedream path', () => {
  const PD: GatewayConnector = {
    connectorId: 'conn-gmail',
    slug: 'gmail',
    provider: 'pipedream',
    baseUrl: null,
    auth: { type: 'none', in: 'header', name: null, prefix: null },
    hasAuth: true,
    shareScope: 'project',
    grants: [],
    credentialMode: 'per_user',
    enabled: true,
  };
  const SEND: GatewayAction = {
    path: 'gmail.send_email',
    relPath: 'send_email',
    inputSchema: { type: 'object', properties: { to: {} } },
    risk: 'write',
    binding: { kind: 'pipedream', app: 'gmail', actionKey: 'gmail-send-email' },
  };

  test('routes to executePipedream with the per-user account binding (not HTTP)', async () => {
    const { deps, fetchCalls, credentialCalls } = makeDeps({ connector: PD, action: SEND, secret: 'apn_abc123' });
    let captured: any = null;
    deps.executePipedream = async (input) => { captured = input; return { status: 200, ok: true, data: { sent: true } }; };
    const res = await handleCall(deps, { ...baseInput, connectorSlug: 'gmail', actionPath: 'send_email', args: { to: 'a@b.com' } });
    expect(res).toEqual({ status: 'ok', data: { sent: true }, risk: 'write' });
    expect(fetchCalls).toHaveLength(0);
    expect(credentialCalls[0]).toEqual({ connectorId: 'conn-gmail', userId: ALICE }); // per_user
    expect(captured).toMatchObject({ app: 'gmail', actionKey: 'gmail-send-email', accountId: 'apn_abc123' });
  });

  test('denied (needs_auth) when this member has not connected', async () => {
    const { deps } = makeDeps({ connector: PD, action: SEND, secret: null });
    expect(await handleCall(deps, { ...baseInput, connectorSlug: 'gmail', actionPath: 'send_email' })).toEqual({ status: 'denied', reason: 'needs_auth' });
  });
});

describe('handleCall — policy layer', () => {
  test('allow-all when enforcePolicies is false even with a block rule', async () => {
    const { deps } = makeDeps({ policies: [{ match: '*', action: 'block' }], enforcePolicies: false });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
  });

  test('block rule denies when enforcement on', async () => {
    const { deps, fetchCalls } = makeDeps({ policies: [{ match: 'charges.*', action: 'block' }], enforcePolicies: true });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('require_approval pauses', async () => {
    const { deps } = makeDeps({ policies: [{ match: '*', action: 'require_approval' }], enforcePolicies: true });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'pending_approval', reason: 'policy_require_approval' });
  });
});

describe('handleCall — layered policies (project → connector → default)', () => {
  test('project [[policies]] block wins even when connector allows', async () => {
    // Connector says "always_run *" — but project says "*.delete*" → block.
    // Project wins (admin trust property).
    const { deps, fetchCalls } = makeDeps({
      action: { ...CREATE_CHARGE, path: 'stripe.charges.delete', relPath: 'charges.delete', risk: 'destructive' },
      projectPolicies: [{ match: '*.delete*', action: 'block' }],
      policies: [{ match: '*', action: 'always_run' }],
    });
    const res = await handleCall(deps, { ...baseInput, actionPath: 'charges.delete' });
    expect(res).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('project [[policies]] sees the fully-qualified path (slug.path)', async () => {
    // Project pattern is "stripe.*" — must include connector slug.
    const { deps } = makeDeps({
      projectPolicies: [{ match: 'stripe.*', action: 'require_approval' }],
    });
    expect((await handleCall(deps, baseInput)).status).toBe('pending_approval');
  });

  test('default_mode=risk: unmatched WRITE → require_approval', async () => {
    const { deps } = makeDeps({ defaultMode: 'risk' });
    expect((await handleCall(deps, baseInput)).status).toBe('pending_approval');
  });

  test('default_mode=risk: unmatched READ → runs', async () => {
    const { deps, fetchCalls } = makeDeps({
      action: { ...CREATE_CHARGE, path: 'stripe.charges.list', relPath: 'charges.list', risk: 'read', binding: { kind: 'openapi', method: 'GET', path: '/v1/charges', server: 'https://api.stripe.com' } },
      defaultMode: 'risk',
    });
    const res = await handleCall(deps, { ...baseInput, actionPath: 'charges.list' });
    expect(res.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
  });

  test('default_mode=allow_all: unmatched destructive still runs', async () => {
    const { deps } = makeDeps({
      action: { ...CREATE_CHARGE, risk: 'destructive' },
      defaultMode: 'allow_all',
    });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
  });

  test('connector always_run overrides risk-default require_approval', async () => {
    const { deps } = makeDeps({
      policies: [{ match: 'charges.create', action: 'always_run' }],
      defaultMode: 'risk', // would otherwise require_approval for risk=write
    });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
  });

  test('block path is audited with policy_block + source', async () => {
    const { deps, records } = makeDeps({
      projectPolicies: [{ match: '*', action: 'block' }],
    });
    await handleCall(deps, baseInput);
    expect(records.at(-1)).toMatchObject({
      status: 'denied',
      resultSummary: { reason: 'policy_block', policy_source: 'project' },
    });
  });
});
