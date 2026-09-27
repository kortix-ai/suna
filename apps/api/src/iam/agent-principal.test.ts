/**
 * Pure decision of spec docs/specs/2026-09-22-agents-as-principals.md §2.1:
 *
 *   effective(agent, action) = action ∈ kortix_permissions
 *                            ∧ action ∈ ceiling(agent)
 *                            ∧ action ∉ HUMAN_ONLY
 *   project.read is always granted inside the agent's own project.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import {
  AGENT_DEFAULT_CEILING,
  HUMAN_ONLY_ACTIONS,
  agentDelegationAllowed,
  agentPrincipalDecision,
  isGovernedAgentGrant,
} from './agent-principal';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function grant(permissions: AgentGrant['permissions'], agent = 'reader'): AgentGrant {
  return { agent, permissions, connectors: 'all' } as AgentGrant;
}

const decide = (
  action: string,
  opts: { grant?: AgentGrant; ceiling?: ReadonlySet<string> | null; target?: string } = {},
) =>
  agentPrincipalDecision({
    action,
    scope: 'project',
    targetProjectId: opts.target ?? PROJECT,
    tokenProjectId: PROJECT,
    grant: opts.grant ?? grant(['project.file.read']),
    // null = no role bound to the agent's service account → default ceiling.
    ceilingAllows: (a) => (opts.ceiling ?? AGENT_DEFAULT_CEILING).has(a),
  });

describe('agentPrincipalDecision', () => {
  test('an action in the grant and in the default ceiling is allowed', () => {
    expect(decide('project.file.read')).toEqual({ allowed: true, reason: 'role' });
  });

  test('an action outside the grant is agent_scope_insufficient', () => {
    expect(decide('project.secret.read')).toEqual({ allowed: false, reason: 'agent_scope_insufficient' });
  });

  test('an action in the grant but outside a bound ceiling is agent_ceiling_insufficient', () => {
    const memberCeiling = new Set(['project.read', 'project.session.read']);
    expect(decide('project.file.read', { ceiling: memberCeiling })).toEqual({
      allowed: false,
      reason: 'agent_ceiling_insufficient',
    });
    expect(decide('project.session.read', { grant: grant(['project.session.read']), ceiling: memberCeiling }).allowed).toBe(true);
  });

  test('HUMAN_ONLY is denied even when the grant lists it or is `all`', () => {
    for (const action of HUMAN_ONLY_ACTIONS) {
      expect(decide(action, { grant: grant([action]) })).toEqual({ allowed: false, reason: 'agent_human_only_action' });
      expect(decide(action, { grant: grant('all') })).toEqual({ allowed: false, reason: 'agent_human_only_action' });
      expect(decide(action, { grant: grant('all'), ceiling: new Set([action]) }).allowed).toBe(false);
    }
  });

  test('project.read is always granted inside the own project, even with an empty ceiling', () => {
    expect(decide('project.read', { grant: grant([]), ceiling: new Set() }).allowed).toBe(true);
  });

  test('project.read on another project is out of scope', () => {
    expect(decide('project.read', { target: OTHER })).toEqual({ allowed: false, reason: 'token_out_of_scope' });
  });

  test('project.write is a coarse membership gate: grant-exempt, ceiling-bound', () => {
    expect(decide('project.write', { grant: grant(['project.file.read']) }).allowed).toBe(true);
    expect(decide('project.write', { ceiling: new Set(['project.read']) })).toEqual({
      allowed: false,
      reason: 'agent_ceiling_insufficient',
    });
  });

  test('`all` is bounded by the ceiling', () => {
    expect(decide('project.secret.read', { grant: grant('all') }).allowed).toBe(true);
    expect(decide('project.secret.read', { grant: grant('all'), ceiling: new Set(['project.read']) }).reason).toBe(
      'agent_ceiling_insufficient',
    );
  });

  test('an account-scoped action is never an agent session\'s', () => {
    expect(
      agentPrincipalDecision({
        action: 'member.read',
        scope: 'account',
        targetProjectId: null,
        tokenProjectId: PROJECT,
        grant: grant('all'),
        ceilingAllows: () => true,
      }),
    ).toEqual({ allowed: false, reason: 'token_out_of_scope' });
  });
});

describe('AGENT_DEFAULT_CEILING', () => {
  test('holds every grantable project permission except HUMAN_ONLY', () => {
    expect(AGENT_DEFAULT_CEILING.has('project.file.read')).toBe(true);
    expect(AGENT_DEFAULT_CEILING.has('project.secret.read')).toBe(true);
    expect(AGENT_DEFAULT_CEILING.has('project.write')).toBe(true);
    for (const action of HUMAN_ONLY_ACTIONS) expect(AGENT_DEFAULT_CEILING.has(action)).toBe(false);
    expect(AGENT_DEFAULT_CEILING.size).toBe(45 - HUMAN_ONLY_ACTIONS.size);
  });
});

describe('isGovernedAgentGrant', () => {
  test('a non-null grant of a non-meta agent is governed', () => {
    expect(isGovernedAgentGrant(grant(['project.file.read']))).toBe(true);
  });
  test('a null grant (project without agents:) is not governed', () => {
    expect(isGovernedAgentGrant(null)).toBe(false);
  });
  test('the platform meta coordinator keeps its platform grant', () => {
    expect(isGovernedAgentGrant(grant('all', 'meta'))).toBe(false);
  });
});

describe('agentDelegationAllowed (spec §2.2: child session from an agent session)', () => {
  test('with a human on behalf of: allowed exactly when that human may run the child agent', () => {
    expect(agentDelegationAllowed({ parentAgent: 'coordinator', target: 'vault', onBehalfOfUserId: 'u1', humanMayRunTarget: false })).toBe(false);
    expect(agentDelegationAllowed({ parentAgent: 'coordinator', target: 'vault', onBehalfOfUserId: 'u1', humanMayRunTarget: true })).toBe(true);
    expect(agentDelegationAllowed({ parentAgent: 'coordinator', target: 'coordinator', onBehalfOfUserId: 'u1', humanMayRunTarget: false })).toBe(false);
  });
  test('with no human (unattended): only the same agent', () => {
    expect(agentDelegationAllowed({ parentAgent: 'coordinator', target: 'coordinator', onBehalfOfUserId: null, humanMayRunTarget: false })).toBe(true);
    expect(agentDelegationAllowed({ parentAgent: 'coordinator', target: 'vault', onBehalfOfUserId: null, humanMayRunTarget: true })).toBe(false);
  });
});

describe('agentEffectiveAllows (the helper surfaces outside authorize call)', () => {
  test('is false for every actor outside the agent-principal model, without a DB read', async () => {
    const { agentEffectiveAllows } = await import('./authorize');
    const base = { userId: 'u', accountId: 'a', ctx: {} };
    expect(await agentEffectiveAllows({ ...base, credential: { kind: 'jwt' } }, 'project.app.read', PROJECT)).toBe(false);
    expect(
      await agentEffectiveAllows(
        {
          ...base,
          credential: {
            kind: 'agent_session',
            tokenId: 't',
            projectId: PROJECT,
            sessionId: 's',
            agentGrant: grant(['project.app.read']),
            serviceAccountId: 'sa',
            activated: false,
            agentPrincipal: false,
          },
        },
        'project.app.read',
      ),
    ).toBe(false);
  });
});
