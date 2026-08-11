// Pure-function tests for the V2 engine. DB-bound paths get covered by
// a separate integration suite that runs only when TEST_DATABASE_URL
// is set (mirrors the V1 setup).

import { describe, test, expect } from 'bun:test';
import {
  scopeForActionV2,
  deriveEffectiveWorkspaceRole,
  customPolicyAllows,
  agentGrantGates,
  computeTokenScope,
  type CustomAction,
} from '../iam/engine-v2';
import { agentMayPerform } from '../iam/agent-scope';
import { ACCOUNT_ACTIONS, WORKSPACE_ACTIONS } from '../iam/actions';

describe('scopeForActionV2', () => {
  test('account.* / billing.* / audit.* → account', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.ACCOUNT_READ)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.ACCOUNT_WRITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.BILLING_WRITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.AUDIT_READ)).toBe('account');
  });

  test('member.* / group.* / role.* / policy.* / token.* → account', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.MEMBER_INVITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.GROUP_CREATE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.TOKEN_CREATE)).toBe('account');
    expect(scopeForActionV2('role.read')).toBe('account');
    expect(scopeForActionV2('policy.read')).toBe('account');
  });

  test('project.create is account (no project to scope to yet)', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.WORKSPACE_CREATE)).toBe('account');
  });

  test('every other project.* → project', () => {
    expect(scopeForActionV2(WORKSPACE_ACTIONS.WORKSPACE_READ)).toBe('project');
    expect(scopeForActionV2(WORKSPACE_ACTIONS.WORKSPACE_WRITE)).toBe('project');
    expect(scopeForActionV2(WORKSPACE_ACTIONS.WORKSPACE_DELETE)).toBe('project');
    expect(scopeForActionV2(WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_FIRE)).toBe('project');
    expect(scopeForActionV2(WORKSPACE_ACTIONS.WORKSPACE_SESSION_START)).toBe('project');
  });

  test('sandbox.* / trigger.* / channel.* collapse into project scope', () => {
    expect(scopeForActionV2('sandbox.start')).toBe('project');
    expect(scopeForActionV2('trigger.fire')).toBe('project');
    expect(scopeForActionV2('channel.send')).toBe('project');
  });
});

describe('deriveEffectiveWorkspaceRole', () => {
  test('owner gets implicit Manager even with no other path', () => {
    expect(deriveEffectiveWorkspaceRole('owner', null, [])).toBe('manager');
  });

  test('admin gets implicit Manager even with no other path', () => {
    expect(deriveEffectiveWorkspaceRole('admin', null, [])).toBe('manager');
  });

  test('member with no direct row and no groups → no role', () => {
    expect(deriveEffectiveWorkspaceRole('member', null, [])).toBeNull();
  });

  test('member with a direct Member row → member', () => {
    expect(deriveEffectiveWorkspaceRole('member', 'member', [])).toBe('member');
  });

  test('member with only a group Editor → editor', () => {
    expect(deriveEffectiveWorkspaceRole('member', null, ['editor'])).toBe('editor');
  });

  test('member with direct Member + group Editor → editor (max wins)', () => {
    expect(deriveEffectiveWorkspaceRole('member', 'member', ['editor'])).toBe('editor');
  });

  test('member with multiple group grants → max of all', () => {
    expect(deriveEffectiveWorkspaceRole('member', null, ['member', 'editor', 'member'])).toBe('editor');
    expect(deriveEffectiveWorkspaceRole('member', null, ['member', 'manager', 'editor'])).toBe('manager');
  });

  test('owner stays Manager even when group says Member (no demotion)', () => {
    expect(deriveEffectiveWorkspaceRole('owner', 'member', ['member'])).toBe('manager');
  });

  test('member with direct Manager → manager (no implicit needed)', () => {
    expect(deriveEffectiveWorkspaceRole('member', 'manager', [])).toBe('manager');
  });
});

describe('customPolicyAllows (DB custom-role union)', () => {
  const proj = (id: string) => ({ type: 'project' as const, id });
  const acct = { type: 'account' as const };

  test('no custom actions → never allows', () => {
    expect(customPolicyAllows([], 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE, proj('p1'))).toBe(false);
  });

  test('project-scoped policy grants only on its own project', () => {
    const ca: CustomAction[] = [{ scopeType: 'project', scopeId: 'p1', action: WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE }];
    expect(customPolicyAllows(ca, 'project', WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE, proj('p1'))).toBe(true);
    expect(customPolicyAllows(ca, 'project', WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE, proj('p2'))).toBe(false);
    // wrong action on the right project
    expect(customPolicyAllows(ca, 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE, proj('p1'))).toBe(false);
  });

  test('account-scoped policy grants on every project AND account actions', () => {
    const ca: CustomAction[] = [{ scopeType: 'account', scopeId: null, action: WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE }];
    expect(customPolicyAllows(ca, 'project', WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE, proj('anything'))).toBe(true);
    const acctCa: CustomAction[] = [{ scopeType: 'account', scopeId: null, action: ACCOUNT_ACTIONS.MEMBER_READ }];
    expect(customPolicyAllows(acctCa, 'account', ACCOUNT_ACTIONS.MEMBER_READ, acct)).toBe(true);
  });

  test('a project-scoped policy can NOT grant an account-scoped action', () => {
    const ca: CustomAction[] = [{ scopeType: 'project', scopeId: 'p1', action: ACCOUNT_ACTIONS.MEMBER_READ }];
    expect(customPolicyAllows(ca, 'account', ACCOUNT_ACTIONS.MEMBER_READ, acct)).toBe(false);
  });

  test('deactivation = omission: a role granting agent.write but not gitops.merge', () => {
    const marketing: CustomAction[] = [
      { scopeType: 'project', scopeId: 'company', action: WORKSPACE_ACTIONS.WORKSPACE_READ },
      { scopeType: 'project', scopeId: 'company', action: WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE },
    ];
    expect(customPolicyAllows(marketing, 'project', WORKSPACE_ACTIONS.WORKSPACE_AGENT_WRITE, proj('company'))).toBe(true);
    // gitops.merge omitted → not granted (Git Ops deactivated for this dept role)
    expect(customPolicyAllows(marketing, 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE, proj('company'))).toBe(false);
  });
});

describe('service-account standing identity — authority is policy-ONLY', () => {
  const proj = (id: string) => ({ type: 'project' as const, id });
  const acct = { type: 'account' as const };
  // A service-account actor (kind:'service_account') has NO membership baseline
  // and NO built-in role: authorizeV2 routes EVERY decision for it straight to
  // customPolicyAllows over its own iam_policies (principal_type='token'). These
  // lock the standing-role semantics the engine relies on for an SA.
  test('an SA with NO policies is denied everything (no member baseline leaks in)', () => {
    const none: CustomAction[] = [];
    expect(customPolicyAllows(none, 'account', ACCOUNT_ACTIONS.MEMBER_READ, acct)).toBe(false);
    expect(customPolicyAllows(none, 'project', WORKSPACE_ACTIONS.WORKSPACE_READ, proj('p1'))).toBe(false);
  });

  test('an SA bound to a project-scoped role acts on THAT project only', () => {
    const releaseBot: CustomAction[] = [
      { scopeType: 'project', scopeId: 'company', action: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH },
      { scopeType: 'project', scopeId: 'company', action: WORKSPACE_ACTIONS.WORKSPACE_CR_OPEN },
    ];
    expect(customPolicyAllows(releaseBot, 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH, proj('company'))).toBe(true);
    // another project → no standing access (the SA is scoped to 'company')
    expect(customPolicyAllows(releaseBot, 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH, proj('other'))).toBe(false);
    // a capability the SA's role omits → denied even on its own project
    expect(customPolicyAllows(releaseBot, 'project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE, proj('company'))).toBe(false);
  });

  test('an account-scoped SA role grants the action across every project', () => {
    const ciBot: CustomAction[] = [{ scopeType: 'account', scopeId: null, action: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE }];
    expect(customPolicyAllows(ciBot, 'project', WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj('a'))).toBe(true);
    expect(customPolicyAllows(ciBot, 'project', WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE, proj('b'))).toBe(true);
  });
});

describe('computeTokenScope — token project-scope (D2 standing-identity)', () => {
  const proj = (id: string) => ({ type: 'project' as const, id });
  const acct = { type: 'account' as const };
  const bind = (over: Partial<{ workspaceId: string | null; agentGrant: null; serviceAccountId: string | null }> = {}) => ({
    workspaceId: null,
    agentGrant: null,
    serviceAccountId: null,
    ...over,
  });

  test('no acting token (JWT/browser) → always in scope', () => {
    expect(computeTokenScope(null, undefined, 'member', 'project', proj('p1'))).toBe(true);
  });

  test('null binding: a direct SA bearer is in scope; a revoked/invalid token is NOT', () => {
    // auth sets actingTokenId = serviceAccountId for a kortix_sa_ bearer; no account_tokens row.
    expect(computeTokenScope(null, 'sa-id', 'service_account', 'project', proj('p1'))).toBe(true);
    // a member acting id with no token row = revoked/invalid → out of scope.
    expect(computeTokenScope(null, 'dead-token', 'member', 'project', proj('p1'))).toBe(false);
  });

  test('unscoped PAT (binding, no workspaceId) → in scope everywhere', () => {
    expect(computeTokenScope(bind(), 'tok', 'member', 'project', proj('p1'))).toBe(true);
    expect(computeTokenScope(bind(), 'tok', 'member', 'account', acct)).toBe(true);
  });

  test('project-bound token (PAT or agent-session SA) → only its project, never account scope', () => {
    const b = bind({ workspaceId: 'company', serviceAccountId: 'sa-marketing' });
    expect(computeTokenScope(b, 'tok', 'service_account', 'project', proj('company'))).toBe(true);
    // a DIFFERENT project → out of scope, even for the SA session (sessions narrow)
    expect(computeTokenScope(b, 'tok', 'service_account', 'project', proj('other'))).toBe(false);
    // account-scope action on a project-bound token → denied
    expect(computeTokenScope(b, 'tok', 'service_account', 'account', acct)).toBe(false);
  });
});

describe('agent grant central fold (userRole ∩ agentGrant)', () => {
  test('gates every specific project capability, EXEMPTs the coarse read/write membership actions', () => {
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH)).toBe(true);
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE)).toBe(true);
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE)).toBe(true);
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE)).toBe(true);
    // connector.write MUST be gated — the connector-admin fold depends
    // on it (a regression adding it to AGENT_GRANT_EXEMPT_ACTIONS would reopen
    // the scoped-agent connector-admin bypass).
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE)).toBe(true);
    // exempt — these are membership-tier gates a leaf-scoped agent must still pass
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_READ)).toBe(false);
    expect(agentGrantGates('project', WORKSPACE_ACTIONS.WORKSPACE_WRITE)).toBe(false);
    // account scope is never gated by the agent grant (project-bound token already denied account scope)
    expect(agentGrantGates('account', ACCOUNT_ACTIONS.MEMBER_INVITE)).toBe(false);
  });

  test('a scoped agent is denied a gated capability it does not hold, but passes exempt + held ones', () => {
    const grant = { agent: 'marketing', kortixCli: [WORKSPACE_ACTIONS.WORKSPACE_CR_OPEN], connectors: 'all' as const };
    const denied = (action: string) => agentGrantGates('project', action) && !agentMayPerform(grant, action);
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE)).toBe(true); // not in kortixCli + gated → denied
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE)).toBe(true);
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_CR_OPEN)).toBe(false); // held → allowed
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_READ)).toBe(false); // exempt → allowed
    // cr.open ≡ gitops.push: the central fold gates CR-create commits as
    // gitops.push, so holding cr.open must satisfy it (no silent double-gate).
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH)).toBe(false);
    // but the merge half of the pair is NOT thereby granted.
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_GITOPS_MERGE)).toBe(true);
    expect(denied(WORKSPACE_ACTIONS.WORKSPACE_CR_MERGE)).toBe(true);
  });

  test('all-grant and null-grant impose no restriction', () => {
    const all = { agent: 'kortix', kortixCli: 'all' as const, connectors: 'all' as const };
    expect(agentMayPerform(all, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH)).toBe(true);
    expect(agentMayPerform(null, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH)).toBe(true);
  });
});
