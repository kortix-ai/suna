/**
 * Connector policy sets: the agent-set layer of `resolveEffectiveAction`, the
 * grant plumbing that carries an agent's set to the gateway, and the manifest
 * parsers. These decide permissions, so every layer and the fail-closed paths
 * are pinned.
 */
import { describe, expect, test } from 'bun:test';
import { resolveEffectiveAction, type Policy } from '../connectors/policy';
import { agentPolicySet, canonicalizeGrantConnectors } from '../iam/agent-scope';
import { agentGrantDiffers } from '../projects/lib/secret-grant';
import { readAgentPolicySets } from '../projects/agents/parse';
import { extractAgents, grantsByAgent } from '../projects/agents';
import { grantFromLoadedAgents } from '../projects/agents/grants';
import { extractConnectors } from '../projects/connectors';
import type { AgentGrant } from '@kortix/db';
import type { ParsedManifest } from '../projects/triggers';
import { changedPolicySet, findGrantEscalation, holdsEveryGrant } from '../iam/agent-grant-ceiling';
import { agentsUsingPolicySet, mergeConnectorDraftEntry } from '../connectors/manifest-crud';
import { applyAgentScopeV2, dropEmptyPolicySets } from '../projects/lib/agent-config-v2';

function resolve(opts: {
  project?: Policy[];
  set?: Policy[];
  base?: Policy[];
  setMissing?: boolean;
  path?: string;
  args?: Record<string, unknown>;
}) {
  const path = opts.path ?? 'send_email';
  return resolveEffectiveAction({
    fullPath: `gmail.${path}`,
    relPath: path,
    projectPolicies: opts.project ?? [],
    setPolicies: opts.set,
    setMissing: opts.setMissing,
    connectorPolicies: opts.base ?? [],
    risk: 'write',
    defaultMode: 'allow_all',
    args: opts.args ?? {},
    argsAvailable: true,
  });
}

describe('resolver: agent set layer', () => {
  test('no set (no agent): the base rules decide', () => {
    expect(resolve({ base: [{ match: 'send_*', action: 'block' }] })).toEqual({ action: 'block', source: 'connector' });
  });

  test('a set rule decides before the base rules (it can loosen them)', () => {
    expect(
      resolve({ set: [{ match: 'send_email', action: 'always_run' }], base: [{ match: 'send_*', action: 'block' }] }),
    ).toEqual({ action: 'always_run', source: 'policy_set' });
  });

  test('a set rule can tighten the base rules', () => {
    expect(
      resolve({ set: [{ match: 'send_*', action: 'block' }], base: [{ match: '*', action: 'always_run' }] }),
    ).toEqual({ action: 'block', source: 'policy_set' });
  });

  test('project rules still win over a set', () => {
    expect(
      resolve({ project: [{ match: 'gmail.send_*', action: 'require_approval' }], set: [{ match: '*', action: 'always_run' }] }),
    ).toEqual({ action: 'require_approval', source: 'project' });
  });

  test('a set with no matching rule falls through to the base rules, then the default', () => {
    expect(resolve({ set: [{ match: 'list_*', action: 'block' }], base: [{ match: 'send_*', action: 'require_approval' }] })).toEqual({
      action: 'require_approval',
      source: 'connector',
    });
    expect(resolve({ set: [] })).toEqual({ action: 'always_run', source: 'allow_all' });
  });

  test('first match wins inside the set, in position order', () => {
    expect(
      resolve({
        set: [
          { match: '*', action: 'block', position: 1 },
          { match: 'send_email', action: 'always_run', position: 0 },
        ],
      }),
    ).toEqual({ action: 'always_run', source: 'policy_set' });
  });

  test('set rules honor argument conditions', () => {
    const set: Policy[] = [
      { match: 'send_email', action: 'always_run', conditions: [{ arg: 'to', match: '*@example.com' }] },
      { match: 'send_email', action: 'block' },
    ];
    expect(resolve({ set, args: { to: 'a@example.com' } }).action).toBe('always_run');
    expect(resolve({ set, args: { to: 'a@other.test' } }).action).toBe('block');
  });

  test('a missing set blocks, even over a project always_run', () => {
    expect(resolve({ setMissing: true, project: [{ match: '*', action: 'always_run' }] })).toEqual({
      action: 'block',
      source: 'policy_set',
    });
  });
});

const grant = (extra: Partial<AgentGrant> = {}): AgentGrant => ({
  agent: 'support',
  permissions: [],
  connectors: ['gmail'],
  env: [],
  ...extra,
});

describe('grant: policySets', () => {
  test('agentPolicySet reads own keys only, with the * fallback', () => {
    expect(agentPolicySet(null, 'gmail')).toBeNull();
    expect(agentPolicySet(grant(), 'gmail')).toBeNull();
    expect(agentPolicySet(grant({ policySets: { gmail: 'read_only' } }), 'gmail')).toBe('read_only');
    // A stored grant is parsed JSON on a normal prototype.
    const parsed = JSON.parse(JSON.stringify(grant({ policySets: { gmail: 'read_only' } }))) as AgentGrant;
    expect(agentPolicySet(parsed, 'constructor')).toBeNull();
    expect(agentPolicySet(grant({ policySets: { '*': '' } }), 'stripe')).toBe('');
  });

  test('canonicalization rewrites alias keys, also under connectors: all', () => {
    const out = canonicalizeGrantConnectors(grant({ connectors: 'all', policySets: { email: 'quiet' } }));
    expect(agentPolicySet(out, 'kortix_email')).toBe('quiet');
  });

  test('agentGrantDiffers sees a policySets change and ignores key order', () => {
    expect(agentGrantDiffers(grant(), grant({ policySets: { gmail: 'read_only' } }))).toBe(true);
    expect(
      agentGrantDiffers(grant({ policySets: { gmail: 'read_only' } }), grant({ policySets: { gmail: 'outreach' } })),
    ).toBe(true);
    expect(
      agentGrantDiffers(
        grant({ policySets: { a: 'x', gmail: 'read_only' } }),
        grant({ policySets: { gmail: 'read_only', a: 'x' } }),
      ),
    ).toBe(false);
  });
});

function manifestOf(raw: Record<string, unknown>): ParsedManifest {
  return { raw, schemaVersion: 2, path: 'kortix.yaml', format: 'yaml' } as unknown as ParsedManifest;
}

const MANIFEST = {
  kortix_version: 2,
  agents: {
    support: { connectors: ['gmail'], policy_sets: { gmail: 'read_only' } },
    broken: { connectors: ['gmail', 'slack'], policy_sets: { gmail: 'nope', stripe: 7 } },
    plain: { connectors: ['gmail'] },
  },
  connectors: [
    {
      slug: 'gmail',
      provider: 'composio',
      app: 'gmail',
      policies: [{ match: 'delete_*', action: 'block' }],
      policy_sets: {
        read_only: { description: ' Read only ', policies: [{ match: 'send_*', action: 'block' }] },
        empty: {},
        outreach: {
          policies: [{ match: 'send_email', action: 'require_approval', conditions: [{ arg: 'to', match: '*@example.com' }] }],
        },
      },
    },
  ],
};

describe('manifest parse', () => {
  test('connector policy_sets parse in order, with descriptions and conditions', () => {
    const { specs, errors } = extractConnectors(manifestOf(MANIFEST));
    expect(errors).toEqual([]);
    expect(specs[0]!.policySets).toEqual([
      { name: 'read_only', description: 'Read only', policies: [{ match: 'send_*', action: 'block' }] },
      { name: 'empty', description: null, policies: [] },
      {
        name: 'outreach',
        description: null,
        policies: [{ match: 'send_email', action: 'require_approval', conditions: [{ arg: 'to', match: '*@example.com' }] }],
      },
    ]);
  });

  test('a reserved or bad set name, or a bad rule, fails the connector', () => {
    for (const sets of [{ base: {} }, { 'Bad Name': {} }, { ok: { policies: [{ match: 'x', action: 'nope' }] } }]) {
      const out = extractConnectors(manifestOf({ ...MANIFEST, connectors: [{ ...MANIFEST.connectors[0], policy_sets: sets }] }));
      expect(out.specs).toEqual([]);
      expect(out.errors).toHaveLength(1);
    }
  });

  test('agent policy_sets reach the grant; bad entries are kept, never dropped, and the agent stays valid', () => {
    const loaded = extractAgents(manifestOf(MANIFEST));
    expect(loaded.errors).toEqual([]);
    expect(agentPolicySet(grantFromLoadedAgents('support', loaded), 'gmail')).toBe('read_only');
    const broken = grantFromLoadedAgents('broken', loaded);
    expect(broken?.connectors).toEqual(['gmail', 'kortix_slack']);
    expect(agentPolicySet(broken, 'gmail')).toBe('nope');
    expect(agentPolicySet(broken, 'stripe')).toBe('');
    expect(agentPolicySet(grantFromLoadedAgents('plain', loaded), 'gmail')).toBeNull();
  });

  test('a malformed policy_sets map blocks every connector for the agent', () => {
    const map = readAgentPolicySets('read_only');
    expect(agentPolicySet(grant({ policySets: map }), 'gmail')).toBe('');
    expect(readAgentPolicySets(undefined)).toBeUndefined();
  });
});

describe('grant ceiling: policy_sets', () => {
  const writer = grant({ agent: 'helper', permissions: ['project.agent.write'] });
  const run = (holds: string[], before: AgentGrant | undefined, after: AgentGrant) =>
    findGrantEscalation({
      writer,
      writerMayPerform: async (action) => holds.includes(action),
      allPermissions: [],
      before: new Map(before ? [[after.agent, before]] : []),
      after: new Map([[after.agent, after]]),
    });

  test('a governed writer without connector.write cannot add, change or remove a set', async () => {
    const base = grant();
    const ro = grant({ policySets: { gmail: 'read_only' } });
    const out = grant({ policySets: { gmail: 'outreach' } });
    for (const [b, a] of [[base, ro], [ro, out], [ro, base]] as const) {
      expect(await run(['project.agent.write'], b, a)).toEqual({ target: 'support', dimension: 'policy_sets', item: 'gmail' });
    }
  });

  test('with project.connector.write the change passes; an unchanged map passes without it', async () => {
    expect(await run(['project.connector.write'], grant(), grant({ policySets: { gmail: 'read_only' } }))).toBeNull();
    const same = grant({ policySets: { gmail: 'read_only' } });
    expect(await run([], same, { ...same })).toBeNull();
  });

  test('changing or dropping an entry on an un-granted connector is a change (un-grant, drop, re-grant)', async () => {
    const ungranted = grant({ connectors: [], policySets: { gmail: 'read_only' } });
    expect(await run(['project.agent.write'], ungranted, grant({ connectors: [] }))).toEqual({
      target: 'support',
      dimension: 'policy_sets',
      item: 'gmail',
    });
    expect(changedPolicySet(grant({ connectors: [] }), grant({ connectors: [], policySets: { gmail: 'x' } }))).toBe('gmail');
  });

  test('un-granting a connector and dropping its set in one write is a change', async () => {
    const ro = grant({ connectors: ['gmail', 'stripe'], policySets: { gmail: 'read_only' } });
    const stripeOnly = grant({ connectors: ['stripe'] });
    expect(await run(['project.agent.write'], ro, stripeOnly)).toEqual({ target: 'support', dimension: 'policy_sets', item: 'gmail' });
    // Step 2 of the bypass: re-grant with no set before or after.
    expect(changedPolicySet(stripeOnly, grant({ connectors: ['stripe', 'gmail'] }))).toBeNull();
  });

  test('un-grant then re-grant through the scope route keeps the set and needs no connector.write', async () => {
    const manifest = manifestOf({
      kortix_version: 2,
      default_agent: 'support',
      agents: { support: { connectors: ['gmail', 'stripe'], policy_sets: { gmail: 'read_only' } } },
      connectors: [
        { slug: 'gmail', provider: 'composio', app: 'gmail', policy_sets: { read_only: { policies: [{ match: 'send_*', action: 'block' }] } } },
        { slug: 'stripe', provider: 'composio', app: 'stripe' },
      ],
    });
    const grants = (m: ParsedManifest) => grantsByAgent(extractAgents(m)).get('support')!;
    const before = grants(manifest);
    const ungranted = applyAgentScopeV2(manifest, 'support', { connectors: ['stripe'] });
    if (!ungranted.ok) throw new Error(JSON.stringify(ungranted));
    expect((ungranted.raw.agents as any).support.policy_sets).toEqual({ gmail: 'read_only' });
    const step1 = grants(manifestOf(ungranted.raw));
    expect(await run(['project.agent.write'], before, step1)).toBeNull();
    const regranted = applyAgentScopeV2(manifestOf(ungranted.raw), 'support', { connectors: ['stripe', 'gmail'] });
    if (!regranted.ok) throw new Error(JSON.stringify(regranted));
    const step2 = grants(manifestOf(regranted.raw));
    expect(await run(['project.agent.write'], step1, step2)).toBeNull();
    expect(step2.policySets).toEqual({ gmail: 'read_only' });
  });

  test('removing an agent that runs under a set needs connector.write', async () => {
    const ro = grant({ policySets: { gmail: 'read_only' } });
    const remove = (holds: string[]) =>
      findGrantEscalation({
        writer,
        writerMayPerform: async (action) => holds.includes(action),
        allPermissions: [],
        before: new Map([['support', ro]]),
        after: new Map(),
      });
    expect(await remove(['project.agent.write'])).toEqual({ target: 'support', dimension: 'policy_sets', item: 'gmail' });
    expect(await remove(['project.connector.write'])).toBeNull();
    // Removing an agent with no set stays allowed.
    expect(
      await findGrantEscalation({
        writer,
        writerMayPerform: async () => false,
        allPermissions: [],
        before: new Map([['plain', grant({ agent: 'plain' })]]),
        after: new Map(),
      }),
    ).toBeNull();
  });

  test('holdsEveryGrant is false for a writer bound by a set, or without connector.write', async () => {
    const everything = async () => true;
    expect(await holdsEveryGrant(grant({ policySets: { gmail: 'read_only' } }), everything)).toBe(false);
    expect(await holdsEveryGrant(grant({ permissions: 'all', connectors: 'all', env: 'all', apps: 'all' }), async (a) => a !== 'project.connector.write')).toBe(false);
    expect(await holdsEveryGrant(grant({ permissions: 'all', connectors: 'all', env: 'all', apps: 'all' }), everything)).toBe(true);
  });
});

describe('manifest writes keep policy_sets', () => {
  test('a connector edit keeps policy_sets', () => {
    const previous = { slug: 'gmail', provider: 'composio', app: 'gmail', policy_sets: { read_only: {} } };
    const entry = mergeConnectorDraftEntry({ slug: 'gmail', provider: 'composio', app: 'gmail' } as never, previous);
    expect(entry.policy_sets).toEqual({ read_only: {} });
  });

  test('un-granting a connector keeps its set entry; only an emptied map is dropped', () => {
    const none: Record<string, unknown> = { connectors: [], policy_sets: { gmail: 'read_only' } };
    dropEmptyPolicySets(none);
    expect(none.policy_sets).toEqual({ gmail: 'read_only' });
    const empty: Record<string, unknown> = { connectors: ['gmail'], policy_sets: {} };
    dropEmptyPolicySets(empty);
    expect('policy_sets' in empty).toBe(false);
  });

  test('scope edits merge per slug; null and base remove; an unknown set is refused by the validator', () => {
    const clean = structuredClone(MANIFEST) as Record<string, any>;
    clean.default_agent = 'support';
    delete clean.agents.broken;
    const manifest = manifestOf(clean);
    const applied = applyAgentScopeV2(manifest, 'support', { policySets: { gmail: 'outreach' } });
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    expect((applied.raw.agents as any).support.policy_sets).toEqual({ gmail: 'outreach' });
    const cleared = applyAgentScopeV2(manifestOf(applied.ok ? applied.raw : {}), 'support', { policySets: { gmail: 'base' } });
    expect(cleared.ok && (cleared.raw.agents as any).support.policy_sets).toBeUndefined();
    const unknown = applyAgentScopeV2(manifestOf(structuredClone(clean)), 'support', { policySets: { gmail: 'nope' } });
    expect(unknown.ok).toBe(false);
  });

  test('agentsUsingPolicySet reads either alias spelling', () => {
    const raw = { agents: { a: { policy_sets: { email: 'quiet' } }, b: { policy_sets: { kortix_email: 'quiet' } }, c: {} } };
    expect(agentsUsingPolicySet({ raw }, 'kortix_email', 'quiet')).toEqual(['a', 'b']);
  });
});
