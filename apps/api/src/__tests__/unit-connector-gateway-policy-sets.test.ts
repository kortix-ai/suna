/**
 * The gateway applies the calling agent's policy set: the same call is
 * allowed for one agent and blocked for another on ONE connector, a missing
 * set blocks (fail closed), and the denial and the audit row name the set.
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
import type { Policy } from '../connectors/policy';

const GMAIL: GatewayConnector = {
  connectorId: 'conn-gmail',
  slug: 'gmail',
  provider: 'openapi',
  baseUrl: 'https://mail.example.test',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const SEND: GatewayAction = {
  path: 'gmail.send_email',
  relPath: 'send_email',
  inputSchema: { type: 'object', properties: { to: {} } },
  risk: 'write',
  binding: { kind: 'openapi', method: 'POST', path: '/send', server: 'https://mail.example.test' },
};

const SETS: Record<string, Policy[]> = {
  read_only: [{ match: 'send_*', action: 'block' }],
  outreach: [{ match: 'send_email', action: 'always_run' }],
};

function makeDeps(opts: { base?: Policy[]; project?: Policy[]; loadPolicySet?: GatewayDeps['loadPolicySet'] | null } = {}) {
  const records: ExecutionRecord[] = [];
  let calls = 0;
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => GMAIL,
    loadAction: async () => SEND,
    resolveCredential: async () => 'token',
    loadPolicies: async () => opts.base ?? [{ match: 'send_*', action: 'require_approval' }],
    loadProjectPolicies: async () => opts.project ?? [],
    loadDefaultMode: async () => 'allow_all',
    ...(opts.loadPolicySet === null
      ? {}
      : { loadPolicySet: opts.loadPolicySet ?? (async (_id, name) => (Object.hasOwn(SETS, name) ? SETS[name]! : null)) }),
    recordExecution: async (r) => {
      records.push(r);
      return null;
    },
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, ok: true, text: async () => '{"id":"m1"}' };
    },
  };
  return { deps, records, upstreamCalls: () => calls };
}

const input = (policySet: string | null): CallInput => ({
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: 'user-1', groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: 'gmail',
  actionPath: 'send_email',
  args: { to: 'a@example.com' },
  policySet: policySet === null ? null : { name: policySet, agent: policySet === 'read_only' ? 'support' : 'sales', manifestCommit: 'c0ffee' },
});

describe('gateway: agent policy sets', () => {
  test('one connector, two agents: outreach runs, read_only is blocked and named', async () => {
    const sales = makeDeps();
    expect((await handleCall(sales.deps, input('outreach'))).status).toBe('ok');
    expect(sales.upstreamCalls()).toBe(1);

    const support = makeDeps();
    const denied = await handleCall(support.deps, input('read_only'));
    expect(denied).toMatchObject({ status: 'denied', reason: 'policy_block', policySet: 'read_only', agent: 'support' });
    expect(support.upstreamCalls()).toBe(0);
    const audit = support.records.at(-1)!;
    expect(audit.status).toBe('denied');
    expect(audit.resultSummary).toMatchObject({
      reason: 'policy_block',
      policy_source: 'policy_set',
      policy_set: 'read_only',
      agent: 'support',
      manifest_commit: 'c0ffee',
    });
  });

  test('no set: the base rules decide (here: approval)', async () => {
    const { deps } = makeDeps();
    expect((await handleCall(deps, input(null))).status).toBe('pending_approval');
  });

  test('a project rule still wins over a set', async () => {
    const { deps, records } = makeDeps({ project: [{ match: 'gmail.send_email', action: 'block' }] });
    expect(await handleCall(deps, input('outreach'))).toEqual({ status: 'denied', reason: 'policy_block' });
    const summary = records.at(-1)!.resultSummary as Record<string, unknown>;
    expect(summary.policy_source).toBe('project');
    expect('policy_set' in summary || 'agent' in summary).toBe(false);
  });

  test('a call the project rule holds for approval does not credit the set in the audit row', async () => {
    const { deps, records } = makeDeps({ project: [{ match: 'gmail.send_*', action: 'require_approval' }] });
    expect((await handleCall(deps, input('read_only'))).status).toBe('pending_approval');
    const summary = records.at(-1)!.resultSummary as Record<string, unknown>;
    expect(summary.policy_source).toBe('project');
    expect('policy_set' in summary || 'agent' in summary || 'manifest_commit' in summary).toBe(false);
  });

  test('fail closed: an unknown set, a failed load and a deps without the loader all block', async () => {
    for (const deps of [
      makeDeps().deps,
      makeDeps({ loadPolicySet: async () => { throw new Error('db down'); } }).deps,
      makeDeps({ loadPolicySet: null }).deps,
    ]) {
      const res = await handleCall(deps, input('nope'));
      expect(res).toMatchObject({ status: 'denied', reason: 'policy_set_missing', policySet: 'nope' });
    }
    const { deps, records } = makeDeps();
    await handleCall(deps, input('nope'));
    expect(records.at(-1)!.resultSummary).toMatchObject({ reason: 'policy_set_missing', policy_set: 'nope' });
  });
});
