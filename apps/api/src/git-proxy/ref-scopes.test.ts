/**
 * The single most important assertion in this file is
 * "an ungoverned project does NOT widen a session".
 *
 * `agentMayPerform(null, …)` returns TRUE — a null agent grant means "no
 * restriction" — and null is what every project that never adopted `agents:`
 * has. Verified live on dev 2026-08-31: a probe project's `kortix cr open`
 * sailed past `assertAgentScope(project.gitops.push)` for exactly that reason.
 * Reading the git ref leaves through that helper would hand unrestricted ref
 * authority to precisely the projects this change exists to protect.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

/** What the IAM engine will answer for the next human ref-scope question. */
let iamAllows = true;
let iamAsked: string[] = [];
const realActor = await import('../iam/actor');
mock.module('../iam/actor', () => ({ ...realActor, actorForToken: async () => ({ userId: 'u1' }) }));
const realAuthorize = await import('../iam/authorize');
mock.module('../iam/authorize', () => ({
  ...realAuthorize,
  authorize: async (_actor: unknown, action: string) => {
    iamAsked.push(action);
    return { allowed: iamAllows };
  },
}));

const { denialsAfterScopes, principalHoldsRefScope } = await import('./ref-scopes');
import type { GitPrincipal, GitRefScope } from './ref-policy';

const PROJECT = { projectId: 'proj-1', accountId: 'acc-1' };

beforeEach(() => {
  iamAllows = true;
  iamAsked = [];
});

const SESSION_ID = 'sess-1';
const session: GitPrincipal = { kind: 'session', sessionId: SESSION_ID, branch: SESSION_ID };
const monitor: GitPrincipal = { kind: 'monitor' };
const user: GitPrincipal = { kind: 'user', userId: 'u1', tokenId: 'tok-1' };
const internal: GitPrincipal = { kind: 'internal' };

/**
 * Minimal Hono-context stand-in. The resolver reads `agentGrant` for a session,
 * and `deriveRequestContext` reads request headers for a person (IP / AAL are
 * folded into the authorize cache key).
 */
function ctxWithGrant(grant: unknown): any {
  return {
    get: (key: string) => (key === 'agentGrant' ? grant : undefined),
    req: { header: () => undefined },
  };
}

const ANY: GitRefScope = 'project.gitops.ref.any';
const DEL: GitRefScope = 'project.gitops.ref.delete';

describe('principalHoldsRefScope — session', () => {
  test('an UNGOVERNED project (null grant) does NOT widen a session', async () => {
    const c = ctxWithGrant(null);
    expect(await principalHoldsRefScope(c, session, PROJECT, ANY)).toBe(false);
    expect(await principalHoldsRefScope(c, session, PROJECT, DEL)).toBe(false);
  });

  test('a governed project that did not list the leaf does not widen either', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: ['project.gitops.push'] });
    expect(await principalHoldsRefScope(c, session, PROJECT, ANY)).toBe(false);
  });

  test('an explicitly listed leaf widens exactly that leaf', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: ['project.gitops.push', ANY] });
    expect(await principalHoldsRefScope(c, session, PROJECT, ANY)).toBe(true);
    expect(await principalHoldsRefScope(c, session, PROJECT, DEL)).toBe(false);
  });

  test('a wildcard grant widens both', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(await principalHoldsRefScope(c, session, PROJECT, ANY)).toBe(true);
    expect(await principalHoldsRefScope(c, session, PROJECT, DEL)).toBe(true);
  });

  test('an empty list is deny, not wildcard', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [] });
    expect(await principalHoldsRefScope(c, session, PROJECT, ANY)).toBe(false);
  });
});

describe('principalHoldsRefScope — other principals', () => {
  test('a person is ASKED of the IAM engine, not assumed', async () => {
    const c = ctxWithGrant(null);
    iamAllows = true;
    expect(await principalHoldsRefScope(c, user, PROJECT, DEL)).toBe(true);
    expect(iamAsked).toEqual(['project.gitops.ref.delete']);
  });

  test('a person WITHOUT the leaf cannot delete a branch', async () => {
    // The tightening: `project.gitops.push` authorizes a push, not a deletion.
    // `manager` is seeded with .ref.delete by the migration, so a manager is
    // unaffected; a plain member with push rights is now refused.
    iamAllows = false;
    expect(await principalHoldsRefScope(ctxWithGrant(null), user, PROJECT, DEL)).toBe(false);
  });

  test('an ACCOUNT API KEY has no user identity, so ownership stands alone', async () => {
    // authorizeGitProxy already proved the account owns the project; there is
    // no principal to evaluate a role against, and no IAM question to ask.
    const key: GitPrincipal = { kind: 'user', userId: null };
    iamAllows = false;
    expect(await principalHoldsRefScope(ctxWithGrant(null), key, PROJECT, DEL)).toBe(true);
    expect(iamAsked).toEqual([]);
  });

  test('internal holds both', async () => {
    expect(await principalHoldsRefScope(ctxWithGrant(null), internal, PROJECT, ANY)).toBe(true);
  });

  test('a monitor holds nothing — there is no principal behind it', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(await principalHoldsRefScope(c, monitor, PROJECT, ANY)).toBe(false);
    expect(await principalHoldsRefScope(c, monitor, PROJECT, DEL)).toBe(false);
  });
});

describe('denialsAfterScopes', () => {
  type Denial = { ref: string; reason: string; requires?: GitRefScope[] };
  const scoped: Denial = { ref: 'refs/heads/main', reason: 'nope', requires: [ANY] };
  const structural: Denial = { ref: 'refs/heads/main', reason: 'floor' };

  test('a structural denial stands even under a wildcard grant', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(await denialsAfterScopes(c, session, PROJECT, [structural])).toEqual([structural]);
  });

  test('a scoped denial is lifted by the matching grant', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(await denialsAfterScopes(c, session, PROJECT, [scoped])).toEqual([]);
  });

  test('a COMPOUND denial needs every leaf — holding one is not enough', async () => {
    const compound: Denial = { ref: 'refs/heads/x', reason: 'nope', requires: [ANY, DEL] };
    const onlyAny = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(await denialsAfterScopes(onlyAny, session, PROJECT, [compound])).toEqual([compound]);
    const both = ctxWithGrant({ agent: 'main', kortixCli: [ANY, DEL] });
    expect(await denialsAfterScopes(both, session, PROJECT, [compound])).toEqual([]);
  });

  test('a scoped denial stands without the grant', async () => {
    expect(await denialsAfterScopes(ctxWithGrant(null), session, PROJECT, [scoped])).toEqual([scoped]);
  });

  test('a mixed push keeps the structural denial and drops the granted one', async () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(await denialsAfterScopes(c, session, PROJECT, [scoped, structural])).toEqual([structural]);
  });

  test('no denials means no scope is ever consulted', async () => {
    // The hot path: the resolver must be reachable only through a denial, so an
    // empty list can never trigger an authorization read.
    const c = {
      get: () => {
        throw new Error('agentGrant must not be read when nothing was denied');
      },
    } as any;
    expect(await denialsAfterScopes(c, session, PROJECT, [])).toEqual([]);
  });
});
