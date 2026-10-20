/**
 * Gateway orchestrator — full decision+execution path with fakes. A connector
 * is project-wide visible (no per-connector member/agent scoping); the
 * credential is always the one shared project credential (`per_user` was
 * removed 2026-07-05) via resolveCredential. Covers success, not-found,
 * needs-auth, audit, pipedream, and policy enforcement.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CallInput,
  type ExecutionRecord,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../connectors/gateway';
import type { DefaultMode, Policy } from '../connectors/policy';
import { SecretUndecryptableError } from '../secrets/undecryptable';
import type { ChannelWriteMisfire } from '../connectors/channel-write-scope';

const ALICE = 'user-alice';

const STRIPE: GatewayConnector = {
  connectorId: 'conn-stripe',
  slug: 'stripe',
  provider: 'openapi',
  baseUrl: 'https://api.stripe.com',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const CREATE_CHARGE: GatewayAction = {
  path: 'stripe.charges.create',
  relPath: 'charges.create',
  inputSchema: { type: 'object', properties: { amount: {} } },
  risk: 'write',
  binding: {
    kind: 'openapi',
    method: 'POST',
    path: '/v1/charges',
    server: 'https://api.stripe.com',
  },
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
  /** Upstream deadline for the call; default is the configured 60 s. */
  callTimeoutMs?: number;
  /** When set, gateChannelWrite answers a gate whose misfire always returns it. */
  misfire?: ChannelWriteMisfire;
  /** Replaces the default recording fetch. */
  fetchImpl?: GatewayDeps['fetchImpl'];
}

function makeDeps(o: FakeOpts = {}) {
  const records: ExecutionRecord[] = [];
  const fetchCalls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const credentialCalls: Array<{ connectorId: string; userId: string | null }> = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => (o.connector === undefined ? STRIPE : o.connector),
    loadAction: async () => (o.action === undefined ? CREATE_CHARGE : o.action),
    resolveCredential: async (connector, userId) => {
      credentialCalls.push({ connectorId: connector.connectorId, userId });
      return o.secret === undefined ? 'sk_live_123' : o.secret;
    },
    loadPolicies: async () => o.policies ?? [],
    loadProjectPolicies: async () => o.projectPolicies ?? [],
    loadDefaultMode: async () => o.defaultMode ?? 'allow_all',
    enforcePolicies: o.enforcePolicies,
    recordExecution: async (r) => {
      records.push(r);
      return null;
    },
    ...(o.callTimeoutMs !== undefined && { callTimeoutMs: o.callTimeoutMs }),
    ...(o.misfire && {
      gateChannelWrite: async () => ({ refusal: null, misfire: () => o.misfire ?? null }),
    }),
    fetchImpl:
      o.fetchImpl ??
      (async (url, init) => {
        fetchCalls.push({ url, ...init });
        const status = o.fetchStatus ?? 200;
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => o.fetchBody ?? '{"id":"ch_1"}',
        };
      }),
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
    expect(res).toEqual({
      status: 'ok',
      data: { id: 'ch_1' },
      risk: 'write',
      binding: 'openapi',
      output: { id: 'ch_1' },
      upstreamStatus: 200,
    });
    expect(fetchCalls[0]!.headers.Authorization).toBe('Bearer sk_live_123');
    expect(credentialCalls[0]).toEqual({ connectorId: 'conn-stripe', userId: null }); // shared
    expect(records.at(-1)).toMatchObject({ status: 'ok', risk: 'write', actingUserId: ALICE });
  });

  test('no-auth connector runs without a credential', async () => {
    const { deps, fetchCalls } = makeDeps({
      connector: { ...STRIPE, hasAuth: false },
      secret: null,
    });
    const res = await handleCall(deps, baseInput);
    expect(res.status).toBe('ok');
    expect(fetchCalls[0]!.headers.Authorization).toBeUndefined();
  });

  // The transcript must always be able to answer "whose account sent that" —
  // the resolved connection's identity (connection-access.ts) rides on the
  // GatewayConnector the deps resolved and is echoed on every ok result.
  test('ok result echoes which account ran it', async () => {
    const { deps } = makeDeps({
      connector: {
        ...STRIPE,
        connectionId: 'conn-row-1',
        connectionLabel: 'Work Stripe',
        connectionOwnerType: 'member',
      },
    });
    const res = await handleCall(deps, baseInput);
    expect(res).toMatchObject({
      status: 'ok',
      account: { connection_id: 'conn-row-1', label: 'Work Stripe', owner_type: 'member' },
    });
  });

  // No resolved connection (a public/no-auth connector) means no account to name —
  // the field must be absent, not a fabricated placeholder.
  test('ok result omits account when the connector resolved no connection', async () => {
    const { deps } = makeDeps();
    const res = await handleCall(deps, baseInput);
    expect(res.status).toBe('ok');
    expect((res as { account?: unknown }).account).toBeUndefined();
  });
});

describe('handleCall — denials', () => {
  test('connector not found', async () => {
    const { deps } = makeDeps({ connector: null });
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'denied',
      reason: 'connector_not_found',
    });
  });

  test('action not found', async () => {
    const { deps } = makeDeps({ action: null });
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'denied',
      reason: 'action_not_found',
    });
  });

  // THE RULE: several accounts reachable, none named, none pinned → the
  // gateway is reason-agnostic — it surfaces whatever `explainMissingConnector`
  // answers verbatim, so `account_required` passes through exactly like
  // `connector_not_connected`/`connector_disabled` already do.
  test('account_required passes through from explainMissingConnector verbatim', async () => {
    const { deps } = makeDeps({ connector: null });
    deps.explainMissingConnector = async () => 'account_required';
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'denied',
      reason: 'account_required',
    });
  });

  test('credential not set → needs_auth', async () => {
    const { deps } = makeDeps({ secret: null });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'needs_auth' });
  });
});

describe('handleCall — upstream + errors', () => {
  test('a credential resolution failure (OAuth2 token refresh) is an error with its message, audited, never sent upstream', async () => {
    // Native OAuth2 client credentials (16d230808a) mint a token per call; a
    // failed mint must answer a structured error the agent can read.
    const { deps, records, fetchCalls } = makeDeps();
    deps.resolveCredential = async () => {
      throw new Error('OAuth2 token request failed (503): temporarily_unavailable');
    };
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'error',
      reason: 'OAuth2 token request failed (503): temporarily_unavailable',
    });
    expect(records.at(-1)).toMatchObject({ status: 'error' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('a stored credential the server cannot decrypt is credential_undecryptable, not needs_auth, and never goes upstream', async () => {
    const { deps, records, fetchCalls } = makeDeps();
    deps.resolveCredential = async () => {
      throw new SecretUndecryptableError('The credential of connector stripe');
    };
    const result = await handleCall(deps, baseInput);
    expect(result).toMatchObject({ status: 'denied', reason: 'credential_undecryptable' });
    expect((result as { message?: string }).message).toContain('connector stripe cannot be decrypted');
    expect(records.at(-1)).toMatchObject({ status: 'denied' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('non-2xx upstream → error with the body excerpt (agent sees the real cause)', async () => {
    const { deps } = makeDeps({ fetchStatus: 402, fetchBody: '{"error":"declined"}' });
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'error',
      reason: 'upstream_402: {"error":"declined"}',
      binding: 'openapi',
      upstreamStatus: 402,
    });
  });

  test('upstream 401 on a stored credential → credential_rejected, names the account and the fix, marks the connection', async () => {
    const { deps, records } = makeDeps({
      connector: { ...STRIPE, connectionId: 'cx-1', connectionLabel: 'Stripe API' },
      fetchStatus: 401,
      fetchBody: '{"error":{"code":"api_key_expired","message":"Expired API Key provided"}}',
    });
    const marks: Array<[string, boolean]> = [];
    deps.markCredentialRejected = async (id, rejected) => {
      marks.push([id, rejected]);
    };
    deps.credentialKind = async () => 'secret';
    const res = await handleCall(deps, baseInput);
    expect(res).toMatchObject({ status: 'error', upstreamStatus: 401 });
    const reason = (res as { reason: string }).reason;
    expect(reason.startsWith('credential_rejected: ')).toBe(true);
    expect(reason).toContain('"Stripe API"');
    expect(reason).toContain('kortix connectors connections credential cx-1');
    expect(reason).toContain('api_key_expired');
    expect(records.at(-1)!.resultSummary).toMatchObject({ http_status: 401, error_code: 'credential_rejected' });
    expect(marks).toEqual([['cx-1', true]]);
  });

  test('401 remedy follows the credential: OAuth signs in again, a project secret is rotated, a repeat 401 says retrying fails', async () => {
    const reasonFor = async (connector: GatewayConnector, kind: string | null) => {
      const { deps } = makeDeps({ connector, fetchStatus: 401, fetchBody: '{"error":"invalid_token"}' });
      const marks: string[] = [];
      deps.markCredentialRejected = async (id) => {
        marks.push(id);
      };
      deps.credentialKind = async () => kind;
      const res = await handleCall(deps, baseInput);
      return { reason: (res as { reason: string }).reason, marks };
    };
    const account = { ...STRIPE, connectionId: 'cx-1', connectionLabel: 'Main' };

    const oauth = await reasonFor(account, 'oauth2_delegated');
    expect(oauth.reason).toContain('signs in to account "Main" again in Connectors');
    expect(oauth.reason).not.toContain('connections credential');

    const projectSecret = await reasonFor({ ...account, authSecret: 'STRIPE_KEY' }, null);
    expect(projectSecret.reason).toContain('project secret STRIPE_KEY');
    expect(projectSecret.reason).not.toContain('connections credential');

    const first = await reasonFor(account, 'secret');
    expect(first.reason).not.toContain('Retrying');
    const repeat = await reasonFor({ ...account, connectionMetadata: { credential_rejected_at: '2026-10-19T00:00:00Z' } }, 'secret');
    expect(repeat.reason).toContain('Retrying returns this error until the credential is replaced.');
    expect(repeat.marks).toEqual([]);
  });

  test('a channel 401 is the platform token, not the account credential: plain upstream_401, no mark', async () => {
    const { deps } = makeDeps({
      connector: { ...STRIPE, provider: 'channel', connectionId: 'cx-1' },
      fetchStatus: 401,
      fetchBody: '',
    });
    const marks: string[] = [];
    deps.markCredentialRejected = async (id) => {
      marks.push(id);
    };
    const res = await handleCall(deps, baseInput);
    expect((res as { reason: string }).reason.startsWith('credential_rejected')).toBe(false);
    expect(marks).toEqual([]);
  });

  test('a later ok call on a marked connection clears the mark; an unmarked one writes nothing', async () => {
    const marked = makeDeps({
      connector: { ...STRIPE, connectionId: 'cx-1', connectionMetadata: { credential_rejected_at: '2026-10-19T00:00:00Z' } },
    });
    const marks: Array<[string, boolean]> = [];
    marked.deps.markCredentialRejected = async (id, rejected) => {
      marks.push([id, rejected]);
    };
    expect(await handleCall(marked.deps, baseInput)).toMatchObject({ status: 'ok' });
    expect(marks).toEqual([['cx-1', false]]);

    const clean = makeDeps({ connector: { ...STRIPE, connectionId: 'cx-2', connectionMetadata: {} } });
    clean.deps.markCredentialRejected = async (id, rejected) => {
      marks.push([id, rejected]);
    };
    await handleCall(clean.deps, baseInput);
    expect(marks).toHaveLength(1);
  });

  test('thrown execution error is caught + audited', async () => {
    const { deps, records } = makeDeps();
    deps.fetchImpl = async () => {
      throw new Error('network down');
    };
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'error', reason: 'network down', binding: 'openapi' });
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
    credentialMode: 'shared',
    enabled: true,
  };
  const SEND: GatewayAction = {
    path: 'gmail.send_email',
    relPath: 'send_email',
    inputSchema: { type: 'object', properties: { to: {} } },
    risk: 'write',
    binding: { kind: 'pipedream', app: 'gmail', actionKey: 'gmail-send-email' },
  };

  test('routes to executePipedream with the shared account binding (not HTTP)', async () => {
    const { deps, fetchCalls, credentialCalls } = makeDeps({
      connector: PD,
      action: SEND,
      secret: 'apn_abc123',
    });
    let captured: any = null;
    deps.executePipedream = async (input) => {
      captured = input;
      return { status: 200, ok: true, data: { sent: true } };
    };
    const res = await handleCall(deps, {
      ...baseInput,
      connectorSlug: 'gmail',
      actionPath: 'send_email',
      args: { to: 'a@b.com' },
    });
    expect(res).toEqual({
      status: 'ok',
      data: { sent: true },
      risk: 'write',
      binding: 'pipedream',
      output: { sent: true },
      upstreamStatus: 200,
    });
    expect(fetchCalls).toHaveLength(0);
    expect(credentialCalls[0]).toEqual({ connectorId: 'conn-gmail', userId: null }); // shared
    expect(captured).toMatchObject({
      app: 'gmail',
      actionKey: 'gmail-send-email',
      accountId: 'apn_abc123',
      userId: null,
    });
  });

  test('connection-bound Pipedream execution uses the same connection-specific OAuth identity', async () => {
    const connectionId = 'a4bbec83-32e5-4c2d-a5af-1dca4911d70f';
    const { deps } = makeDeps({
      connector: { ...PD, connectionId, connectionIsDefault: false },
      action: SEND,
      secret: 'apn_connection',
    });
    let captured: any = null;
    deps.executePipedream = async (input) => {
      captured = input;
      return { status: 200, ok: true, data: { sent: true } };
    };
    await handleCall(deps, {
      ...baseInput,
      connectorSlug: 'gmail',
      actionPath: 'send_email',
      args: { to: 'owner@example.test' },
    });
    expect(captured).toMatchObject({
      accountId: 'apn_connection',
      userId: connectionId,
    });
  });

  test('routes a pipedream_proxy `request` binding to executePipedreamProxy (Connect Proxy)', async () => {
    const REQUEST: GatewayAction = {
      path: 'gmail.request',
      relPath: 'request',
      inputSchema: {
        type: 'object',
        properties: { method: {}, url: {} },
        required: ['method', 'url'],
      },
      risk: 'write',
      binding: { kind: 'pipedream_proxy', app: 'gmail' },
    };
    const { deps, fetchCalls } = makeDeps({ connector: PD, action: REQUEST, secret: 'apn_abc123' });
    let captured: any = null;
    deps.executePipedreamProxy = async (input) => {
      captured = input;
      return { status: 201, ok: true, data: { id: 1 } };
    };
    const res = await handleCall(deps, {
      ...baseInput,
      connectorSlug: 'gmail',
      actionPath: 'request',
      args: { method: 'POST', url: 'https://gmail.googleapis.com/x', body: { a: 1 } },
    });
    expect(res).toEqual({
      status: 'ok',
      data: { id: 1 },
      risk: 'write',
      binding: 'pipedream_proxy',
      output: { id: 1 },
      upstreamStatus: 201,
    });
    expect(fetchCalls).toHaveLength(0); // proxy path, not the HTTP builder
    expect(captured).toMatchObject({ app: 'gmail', accountId: 'apn_abc123' });
    expect(captured.args).toMatchObject({ method: 'POST', url: 'https://gmail.googleapis.com/x' });
  });

  test('denied (needs_auth) when this member has not connected', async () => {
    const { deps } = makeDeps({ connector: PD, action: SEND, secret: null });
    expect(
      await handleCall(deps, { ...baseInput, connectorSlug: 'gmail', actionPath: 'send_email' }),
    ).toEqual({ status: 'denied', reason: 'needs_auth' });
  });
});

describe('handleCall — policy layer', () => {
  test('allow-all when enforcePolicies is false even with a block rule', async () => {
    const { deps } = makeDeps({
      policies: [{ match: '*', action: 'block' }],
      enforcePolicies: false,
    });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
  });

  test('block rule denies when enforcement on', async () => {
    const { deps, fetchCalls } = makeDeps({
      policies: [{ match: 'charges.*', action: 'block' }],
      enforcePolicies: true,
    });
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(fetchCalls).toHaveLength(0);
  });

  test('require_approval returns a one-time pending decision', async () => {
    const { deps } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    // No execution row can be created by this mock, so the result carries no id.
    // The gateway still returns immediately and never requests a retry.
    expect(await handleCall(deps, baseInput)).toEqual({
      status: 'pending_approval',
      reason: 'policy_require_approval',
      executionId: null,
      retryable: false,
    });
  });

  test('require_approval returns immediately without polling the decision row', async () => {
    const { deps, fetchCalls } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    deps.recordExecution = async () => 'exec-new';
    let polled = false;
    (deps as any).waitForApprovalDecision = async () => {
      polled = true;
      return 'approved';
    };
    const res = await handleCall(deps, baseInput);
    expect(res).toEqual({
      status: 'pending_approval',
      reason: 'policy_require_approval',
      executionId: 'exec-new',
      retryable: false,
    });
    expect(fetchCalls).toHaveLength(0);
    expect(polled).toBe(false);
  });

  test('a legacy retry returns immediately and does not poll or stack a row', async () => {
    const { deps, records } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    let waitedOn: string | undefined;
    (deps as any).waitForApprovalDecision = async (id: string) => {
      waitedOn = id;
      return 'timeout';
    };
    let matched: Parameters<NonNullable<GatewayDeps['isPendingApprovalExecution']>>[0] | null =
      null;
    deps.isPendingApprovalExecution = async (input) => {
      matched = input;
      return true;
    };
    const res = await handleCall(deps, {
      ...baseInput,
      approvalExecutionId: 'exec-existing',
    });
    expect(res).toEqual({
      status: 'pending_approval',
      reason: 'policy_require_approval',
      executionId: 'exec-existing',
      retryable: false,
    });
    expect(waitedOn).toBeUndefined();
    expect(matched).toMatchObject({
      executionId: 'exec-existing',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      connectorId: 'conn-stripe',
      actionPath: 'stripe.charges.create',
    });
    expect(matched!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records).toHaveLength(0); // did NOT stack a new pending row on retry
  });

  test('a mismatched legacy retry id creates a fresh exact approval row', async () => {
    const { deps, records } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    deps.isPendingApprovalExecution = async () => false;
    deps.recordExecution = async (record) => {
      records.push(record);
      return 'exec-fresh';
    };

    const res = await handleCall(deps, {
      ...baseInput,
      approvalExecutionId: 'exec-from-another-request',
    });

    expect(res).toMatchObject({
      status: 'pending_approval',
      executionId: 'exec-fresh',
      retryable: false,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      connectorId: 'conn-stripe',
      actionPath: 'stripe.charges.create',
      status: 'pending_approval',
    });
    expect(records[0]!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  // SESSION-WIDE GRANTS WERE REMOVED. This test previously asserted the
  // opposite — that a stored "allow for this session" grant let a gated call run
  // without asking. That is exactly the hole: the grant was keyed on
  // (session, connector, action) and ignored the ARGUMENTS, so one approval of a
  // send to a safe recipient silently covered a send to any other. The grant is
  // no longer consulted, and an existing row must not resurrect the bypass.
  test('a stored session grant no longer bypasses the gate', async () => {
    const { deps, fetchCalls } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    deps.recordExecution = async () => 'exec-p';
    let waited = false;
    (deps as any).waitForApprovalDecision = async () => {
      waited = true;
      return 'timeout';
    };
    // Exact (session, connector, action) "allowed" by a pre-existing row.
    (deps as any).isSessionToolApproved = async (sid: string, _cid: string, action: string) =>
      sid === 'sess-1' && action === 'charges.create';

    const res = await handleCall(deps, baseInput);

    expect(res.status).toBe('pending_approval'); // still gated
    expect(fetchCalls).toHaveLength(0); // the call did NOT run
    expect(waited).toBe(false); // the HTTP request returns; the callback resumes the session
  });

  test('policy BLOCK still short-circuits before any session-grant lookup', async () => {
    const { deps } = makeDeps({
      policies: [{ match: '*', action: 'block' }],
      enforcePolicies: true,
    });
    let consulted = false;
    (deps as any).isSessionToolApproved = async () => {
      consulted = true;
      return true; // even if it would say "allowed"
    };
    expect(await handleCall(deps, baseInput)).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(consulted).toBe(false);
  });

  test('approval carry-over: a recent unconsumed approve lets the fresh call RUN', async () => {
    const { deps, fetchCalls } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    let waited = false;
    (deps as any).waitForApprovalDecision = async () => {
      waited = true;
      return 'timeout';
    };
    const claims: Array<{
      sessionId: string | null;
      actingUserId: string;
      actionPath: string;
      requestDigest: string;
    }> = [];
    deps.consumeApprovedExecution = async (input) => {
      claims.push(input);
      return true;
    };
    const res = await handleCall(deps, baseInput);
    expect(res.status).toBe('ok');
    expect(fetchCalls.length).toBeGreaterThan(0); // the call actually ran
    expect(waited).toBe(false); // no new hold — the grant was already given
    // QUALIFIED path — must match how audit() records connector_calls rows
    // (the relative form would never find the approved row).
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      sessionId: 'sess-1',
      actingUserId: ALICE,
      actionPath: 'stripe.charges.create',
    });
    expect(claims[0]!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('carry-over miss → normal pending flow (asks like before)', async () => {
    const { deps } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    deps.recordExecution = async () => 'exec-p';
    deps.consumeApprovedExecution = async () => false;
    expect((await handleCall(deps, baseInput)).status).toBe('pending_approval');
  });

  test('a no-session caller can consume one exact approval on retry', async () => {
    const { deps, fetchCalls } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    let claim: Parameters<NonNullable<GatewayDeps['consumeApprovedExecution']>>[0] | null = null;
    deps.consumeApprovedExecution = async (input) => {
      claim = input;
      return true;
    };

    const result = await handleCall(deps, { ...baseInput, sessionId: null });

    expect(result.status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    expect(claim).toMatchObject({
      sessionId: null,
      actingUserId: ALICE,
      actionPath: 'stripe.charges.create',
    });
  });

  test('a legacy retry can claim the exact approved request without polling', async () => {
    const { deps } = makeDeps({
      policies: [{ match: '*', action: 'require_approval' }],
      enforcePolicies: true,
    });
    let consulted = false;
    deps.consumeApprovedExecution = async () => {
      consulted = true;
      return true;
    };
    (deps as any).waitForApprovalDecision = async () => 'timeout';
    const res = await handleCall(deps, {
      ...baseInput,
      approvalExecutionId: 'exec-held',
    });
    expect(res.status).toBe('ok');
    expect(consulted).toBe(true);
  });
});

describe('handleCall — approval enrichment and content binding', () => {
  // Key for STRIPE + CREATE_CHARGE (openapi binding): provider + slug + path.
  const KEY = 'openapi:stripe.charges.create';
  const gated = () =>
    makeDeps({ policies: [{ match: '*', action: 'require_approval' }], enforcePolicies: true });
  const content = { to: ['buyer@example.test'], subject: 'Quote', body: 'Hello', api_key: 'k-synthetic' };

  async function digestOf(value: Record<string, unknown>): Promise<string> {
    const { deps, records } = gated();
    deps.approvalEnrichers = { [KEY]: async () => value };
    await handleCall(deps, baseInput);
    return records.at(-1)!.resultSummary!.resolved_digest as string;
  }

  test('a held call stores the redacted content and its digest', async () => {
    const { deps, records } = gated();
    const seen: Array<Record<string, unknown>> = [];
    deps.approvalEnrichers = {
      [KEY]: async (ctx) => {
        seen.push(ctx.args);
        return content;
      },
    };
    const res = await handleCall(deps, baseInput);
    expect(res).toMatchObject({ status: 'pending_approval', reason: 'policy_require_approval' });
    expect(seen).toEqual([{ amount: 500 }]);
    expect(records.at(-1)).toMatchObject({
      status: 'pending_approval',
      resultSummary: {
        reason: 'policy_require_approval',
        resolved_preview: { ...content, api_key: '[redacted]' },
        resolved_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  test('a failed read records resolved_error and still holds the call', async () => {
    const { deps, records } = gated();
    deps.approvalEnrichers = { [KEY]: async () => { throw new Error('upstream 503'); } };
    expect((await handleCall(deps, baseInput)).status).toBe('pending_approval');
    expect(records.at(-1)!.resultSummary).toMatchObject({ resolved_error: 'unavailable' });
    expect(records.at(-1)!.resultSummary).not.toHaveProperty('resolved_preview');
  });

  test('an action with no enricher records no resolved keys', async () => {
    const { deps, records } = gated();
    deps.approvalEnrichers = {};
    await handleCall(deps, baseInput);
    expect(Object.keys(records.at(-1)!.resultSummary!).filter((k) => k.startsWith('resolved_'))).toEqual([]);
  });

  test('carry-over with unchanged content runs the call', async () => {
    const approved = await digestOf(content);
    const { deps, fetchCalls } = gated();
    deps.approvalEnrichers = { [KEY]: async () => ({ ...content }) };
    deps.consumeApprovedExecution = async () => ({ resolvedDigest: approved });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
  });

  test('carry-over with changed content asks again with content_changed', async () => {
    const approved = await digestOf(content);
    const { deps, records, fetchCalls } = gated();
    deps.recordExecution = async (r) => {
      records.push(r);
      return 'exec-fresh';
    };
    deps.approvalEnrichers = { [KEY]: async () => ({ ...content, to: ['someone-else@example.test'] }) };
    deps.consumeApprovedExecution = async () => ({ resolvedDigest: approved });
    deps.isPendingApprovalExecution = async () => true;
    const res = await handleCall(deps, { ...baseInput, approvalExecutionId: 'exec-old' });
    expect(res).toMatchObject({ status: 'pending_approval', reason: 'content_changed', executionId: 'exec-fresh' });
    expect(fetchCalls).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({
      status: 'pending_approval',
      resultSummary: {
        reason: 'content_changed',
        resolved_preview: { to: ['someone-else@example.test'] },
        resolved_digest: expect.not.stringMatching(approved),
      },
    });
  });

  test('carry-over whose content can no longer be read asks again', async () => {
    const { deps, records, fetchCalls } = gated();
    deps.approvalEnrichers = { [KEY]: async () => null };
    deps.consumeApprovedExecution = async () => ({ resolvedDigest: 'a'.repeat(64) });
    expect(await handleCall(deps, baseInput)).toMatchObject({ status: 'pending_approval', reason: 'content_changed' });
    expect(fetchCalls).toHaveLength(0);
    expect(records.at(-1)!.resultSummary).toMatchObject({ reason: 'content_changed', resolved_error: 'unavailable' });
  });

  test('carry-over of an approval with no bound content runs without a read', async () => {
    const { deps, fetchCalls } = gated();
    let reads = 0;
    deps.approvalEnrichers = { [KEY]: async () => { reads += 1; return content; } };
    deps.consumeApprovedExecution = async () => ({ resolvedDigest: null });
    expect((await handleCall(deps, baseInput)).status).toBe('ok');
    expect(reads).toBe(0);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('handleCall — layered policies (project → connector → default)', () => {
  test('project [[policies]] block wins even when connector allows', async () => {
    // Connector says "always_run *" — but project says "*.delete*" → block.
    // Project wins (admin trust property).
    const { deps, fetchCalls } = makeDeps({
      action: {
        ...CREATE_CHARGE,
        path: 'stripe.charges.delete',
        relPath: 'charges.delete',
        risk: 'destructive',
      },
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
      action: {
        ...CREATE_CHARGE,
        path: 'stripe.charges.list',
        relPath: 'charges.list',
        risk: 'read',
        binding: {
          kind: 'openapi',
          method: 'GET',
          path: '/v1/charges',
          server: 'https://api.stripe.com',
        },
      },
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

// The Slack misfire-undo path: a write that landed in another project's
// conversation is taken back (chat.delete) before the gateway answers. The
// undo is best-effort — it must never hold the /call response past the same
// upstream deadline the main request already ran under.
const SLACK: GatewayConnector = {
  connectorId: 'conn-slack',
  slug: 'slack',
  provider: 'channel',
  platform: 'slack',
  baseUrl: 'https://slack.com/api',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const POST_MESSAGE: GatewayAction = {
  path: 'slack.chat.postMessage',
  relPath: 'chat.postMessage',
  inputSchema: { type: 'object', properties: { channel: {}, text: {} } },
  risk: 'write',
  binding: { kind: 'http', method: 'POST', path: '/chat.postMessage' },
};

const MISFIRE: ChannelWriteMisfire = {
  refusal: { reason: 'conversation_not_in_project', message: 'That conversation is not part of this project.' },
  undo: { path: '/chat.delete', args: { channel: 'C0ELSEWHERE', ts: '1700000900.000900' } },
};

const slackInput: CallInput = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: ALICE, groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: 'slack',
  actionPath: 'chat.postMessage',
  args: { channel: 'C0ELSEWHERE', text: 'hi' },
};

/** A fetch that never settles on its own; rejects only when aborted, like the real fetch. */
function hangingFetch(urlsEndingIn: string[], calls: unknown[]): GatewayDeps['fetchImpl'] {
  return async (url, init) => {
    calls.push({ url, init });
    if (urlsEndingIn.some((suffix) => String(url).endsWith(suffix))) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }
    return {
      status: 200,
      ok: true,
      text: async () => '{"ok":true,"channel":"C0ELSEWHERE","ts":"1700000900.000900"}',
    };
  };
}

describe('handleCall — channel misfire undo', () => {
  test('a misfire whose undo fetch hangs still answers within the call deadline', async () => {
    const CALL_MS = 300;
    const calls: unknown[] = [];
    const { deps, records } = makeDeps({
      connector: SLACK,
      action: POST_MESSAGE,
      callTimeoutMs: CALL_MS,
      misfire: MISFIRE,
      fetchImpl: hangingFetch(['/chat.delete'], calls),
    });
    const pending = handleCall(deps, slackInput);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('handleCall hung past the call deadline')), CALL_MS + 1500);
        }),
      ]);
      if (res.status !== 'denied') throw new Error(`expected denied, got ${res.status}`);
      expect(res.message).toBe(
        'That conversation is not part of this project. Kortix could not remove it: delete it in Slack.',
      );
      expect(records.at(-1)).toMatchObject({ status: 'denied', resultSummary: { removed: false } });
      // The undo POST ran under an abort signal bound to the call deadline.
      const undo = calls.at(-1) as { init: { signal?: AbortSignal } };
      expect(undo.init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  });

  test('a misfire whose undo succeeds still reports removal, unchanged', async () => {
    const { deps, records, fetchCalls } = makeDeps({
      connector: SLACK,
      action: POST_MESSAGE,
      misfire: MISFIRE,
    });
    const res = await handleCall(deps, slackInput);
    if (res.status !== 'denied') throw new Error(`expected denied, got ${res.status}`);
    expect(res.message).toBe('That conversation is not part of this project. Kortix removed it.');
    expect(records.at(-1)).toMatchObject({ status: 'denied', resultSummary: { removed: true } });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe('https://slack.com/api/chat.delete');
  });
});
