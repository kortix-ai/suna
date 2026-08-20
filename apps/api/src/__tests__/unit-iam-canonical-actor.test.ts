/**
 * The pure half of the canonical engine: who acts, whether the credential is in
 * scope, and the two derived ids. No database.
 *
 * These are the decisions that used to be an optional trailing argument
 * (`actingTokenId`) and three inline `if`s inside `authorizeV2`. Making them
 * named, total functions over a structured `Actor` is what removes the class of
 * bug where a gate silently forgets the credential.
 */
import { describe, expect, test } from 'bun:test';
import {
  actingPrincipal,
  actingTokenId,
  credentialAgentGrant,
  credentialProjectId,
  pendingPrincipalId,
  type Actor,
} from '../iam/actor';
import { isImplicitManager, tokenScopeAllows, type Obj } from '../iam/authorize';
import { scopeForUncatalogedAction } from '../iam/catalog';

const USER = '11111111-1111-4111-8111-111111111111';
const SA = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'tok-1';

const actor = (credential: Actor['credential'], userId = USER): Actor => ({
  userId,
  accountId: ACCOUNT,
  credential,
  ctx: {},
});

const project: Obj = { type: 'project', id: PROJECT };
const other: Obj = { type: 'project', id: OTHER };
const account: Obj = { type: 'account' };

describe('actingPrincipal', () => {
  test('a browser session acts as the user', () => {
    expect(actingPrincipal(actor({ kind: 'jwt' }))).toEqual({ type: 'user', id: USER });
  });

  test('a PAT acts as the human who minted it', () => {
    expect(actingPrincipal(actor({ kind: 'pat', tokenId: TOKEN, projectId: null }))).toEqual({
      type: 'user',
      id: USER,
    });
  });

  test('an ACTIVATED agent session acts as the agent', () => {
    const a = actor({
      kind: 'agent_session',
      tokenId: TOKEN,
      projectId: PROJECT,
      sessionId: 's',
      agentGrant: null,
      serviceAccountId: SA,
      activated: true,
    });
    expect(actingPrincipal(a)).toEqual({ type: 'service_account', id: SA });
  });

  test('an UNACTIVATED agent session falls back to the launcher', () => {
    // Standing identity is opt-in: a freshly provisioned, role-less agent must
    // keep working as its launcher, not collapse to deny-all.
    const a = actor({
      kind: 'agent_session',
      tokenId: TOKEN,
      projectId: PROJECT,
      sessionId: 's',
      agentGrant: null,
      serviceAccountId: SA,
      activated: false,
    });
    expect(actingPrincipal(a)).toEqual({ type: 'user', id: USER });
  });

  test('a direct service-account bearer is always the service account', () => {
    // Fail-closed, unlike the session fallback above: an explicit SA principal
    // with no role assigned is denied, it does not borrow a human.
    expect(actingPrincipal(actor({ kind: 'service_account', serviceAccountId: SA }, SA))).toEqual({
      type: 'service_account',
      id: SA,
    });
  });
});

describe('credential accessors', () => {
  test('only token credentials carry a token id', () => {
    expect(actingTokenId(actor({ kind: 'jwt' }))).toBeUndefined();
    expect(actingTokenId(actor({ kind: 'sandbox' }))).toBeUndefined();
    expect(actingTokenId(actor({ kind: 'pat', tokenId: TOKEN, projectId: null }))).toBe(TOKEN);
    expect(actingTokenId(actor({ kind: 'service_account', serviceAccountId: SA }, SA))).toBe(SA);
  });

  test('only token credentials carry a project confinement', () => {
    expect(credentialProjectId(actor({ kind: 'jwt' }))).toBeNull();
    expect(credentialProjectId(actor({ kind: 'pat', tokenId: TOKEN, projectId: PROJECT }))).toBe(PROJECT);
  });

  test('only an agent session carries a grant', () => {
    const grant = { agent: 'a', kortixCli: ['project.read'], connectors: 'all' as const };
    expect(credentialAgentGrant(actor({ kind: 'jwt' }))).toBeNull();
    expect(
      credentialAgentGrant(
        actor({
          kind: 'agent_session',
          tokenId: TOKEN,
          projectId: PROJECT,
          sessionId: null,
          agentGrant: grant,
          serviceAccountId: SA,
          activated: true,
        }),
      ),
    ).toEqual(grant);
  });
});

describe('tokenScopeAllows', () => {
  test('a browser request is never token-scoped', () => {
    expect(tokenScopeAllows(null, undefined, 'member', 'account', account)).toBe(true);
    expect(tokenScopeAllows(null, undefined, 'member', 'project', project)).toBe(true);
  });

  test('a missing binding is a revoked token — except for a direct SA bearer', () => {
    // A direct kortix_sa_ bearer has no account_tokens row at all, which is
    // exactly what distinguishes it from a token whose row was revoked.
    expect(tokenScopeAllows(null, TOKEN, 'member', 'project', project)).toBe(false);
    expect(tokenScopeAllows(null, SA, 'service_account', 'project', project)).toBe(true);
  });

  test('an unscoped PAT falls through to permissions', () => {
    expect(tokenScopeAllows({ projectId: null }, TOKEN, 'member', 'account', account)).toBe(true);
    expect(tokenScopeAllows({ projectId: null }, TOKEN, 'member', 'project', project)).toBe(true);
  });

  test('a project-bound token reaches only its own project, and no account action', () => {
    expect(tokenScopeAllows({ projectId: PROJECT }, TOKEN, 'member', 'project', project)).toBe(true);
    expect(tokenScopeAllows({ projectId: PROJECT }, TOKEN, 'member', 'project', other)).toBe(false);
    expect(tokenScopeAllows({ projectId: PROJECT }, TOKEN, 'member', 'account', account)).toBe(false);
    // A project-scoped action with no project target has nothing to compare.
    expect(tokenScopeAllows({ projectId: PROJECT }, TOKEN, 'member', 'project', account)).toBe(false);
  });
});

describe('isImplicitManager', () => {
  test('owner and admin only', () => {
    expect(isImplicitManager('owner')).toBe(true);
    expect(isImplicitManager('admin')).toBe(true);
    expect(isImplicitManager('member')).toBe(false);
    expect(isImplicitManager(null)).toBe(false);
  });
});

describe('scopeForUncatalogedAction', () => {
  test('reproduces scopeForActionV2 for the five actions the catalog drops', () => {
    // project.cr.* collapsed into the gitops leaves; trigger.* deleted. A route
    // that still passes one must land on the same scope, so it lands on the same
    // denial reason.
    expect(scopeForUncatalogedAction('project.cr.open')).toBe('project');
    expect(scopeForUncatalogedAction('project.cr.merge')).toBe('project');
    expect(scopeForUncatalogedAction('trigger.read')).toBe('project');
    expect(scopeForUncatalogedAction('trigger.fire')).toBe('project');
  });

  test('and for the account prefixes', () => {
    for (const a of [
      'account.read',
      'billing.write',
      'audit.read',
      'member.invite',
      'group.read',
      'role.create',
      'policy.delete',
      'token.revoke',
      'project.create',
    ]) {
      expect(scopeForUncatalogedAction(a)).toBe('account');
    }
    expect(scopeForUncatalogedAction('project.read')).toBe('project');
  });
});

describe('pendingPrincipalId', () => {
  test('is deterministic and case/whitespace insensitive', () => {
    const a = pendingPrincipalId('Invitee@Example.com');
    expect(pendingPrincipalId('  invitee@example.com  ')).toBe(a);
    expect(pendingPrincipalId('other@example.com')).not.toBe(a);
  });

  test('is a well-formed v5 uuid', () => {
    const id = pendingPrincipalId('invitee@example.com');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

