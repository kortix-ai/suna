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
import { describe, expect, test } from 'bun:test';
import { denialsAfterScopes, principalHoldsRefScope } from './ref-scopes';
import type { GitPrincipal, GitRefScope } from './ref-policy';

const SESSION_ID = 'sess-1';
const session: GitPrincipal = { kind: 'session', sessionId: SESSION_ID, branch: SESSION_ID };
const monitor: GitPrincipal = { kind: 'monitor' };
const user: GitPrincipal = { kind: 'user', userId: 'u1' };
const internal: GitPrincipal = { kind: 'internal' };

/** Minimal Hono-context stand-in: the resolver only ever reads `agentGrant`. */
function ctxWithGrant(grant: unknown): any {
  return { get: (key: string) => (key === 'agentGrant' ? grant : undefined) };
}

const ANY: GitRefScope = 'project.gitops.ref.any';
const DEL: GitRefScope = 'project.gitops.ref.delete';

describe('principalHoldsRefScope — session', () => {
  test('an UNGOVERNED project (null grant) does NOT widen a session', () => {
    const c = ctxWithGrant(null);
    expect(principalHoldsRefScope(c, session, ANY)).toBe(false);
    expect(principalHoldsRefScope(c, session, DEL)).toBe(false);
  });

  test('a governed project that did not list the leaf does not widen either', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: ['project.gitops.push'] });
    expect(principalHoldsRefScope(c, session, ANY)).toBe(false);
  });

  test('an explicitly listed leaf widens exactly that leaf', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: ['project.gitops.push', ANY] });
    expect(principalHoldsRefScope(c, session, ANY)).toBe(true);
    expect(principalHoldsRefScope(c, session, DEL)).toBe(false);
  });

  test('a wildcard grant widens both', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(principalHoldsRefScope(c, session, ANY)).toBe(true);
    expect(principalHoldsRefScope(c, session, DEL)).toBe(true);
  });

  test('an empty list is deny, not wildcard', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [] });
    expect(principalHoldsRefScope(c, session, ANY)).toBe(false);
  });
});

describe('principalHoldsRefScope — other principals', () => {
  test('a person holds both: their authority came from their project role', () => {
    const c = ctxWithGrant(null);
    expect(principalHoldsRefScope(c, user, ANY)).toBe(true);
    expect(principalHoldsRefScope(c, user, DEL)).toBe(true);
  });

  test('internal holds both', () => {
    expect(principalHoldsRefScope(ctxWithGrant(null), internal, ANY)).toBe(true);
  });

  test('a monitor holds nothing — there is no principal behind it', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(principalHoldsRefScope(c, monitor, ANY)).toBe(false);
    expect(principalHoldsRefScope(c, monitor, DEL)).toBe(false);
  });
});

describe('denialsAfterScopes', () => {
  type Denial = { ref: string; reason: string; requires?: GitRefScope[] };
  const scoped: Denial = { ref: 'refs/heads/main', reason: 'nope', requires: [ANY] };
  const structural: Denial = { ref: 'refs/heads/main', reason: 'floor' };

  test('a structural denial stands even under a wildcard grant', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: 'all' });
    expect(denialsAfterScopes(c, session, [structural])).toEqual([structural]);
  });

  test('a scoped denial is lifted by the matching grant', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(denialsAfterScopes(c, session, [scoped])).toEqual([]);
  });

  test('a COMPOUND denial needs every leaf — holding one is not enough', () => {
    const compound: Denial = { ref: 'refs/heads/x', reason: 'nope', requires: [ANY, DEL] };
    const onlyAny = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(denialsAfterScopes(onlyAny, session, [compound])).toEqual([compound]);
    const both = ctxWithGrant({ agent: 'main', kortixCli: [ANY, DEL] });
    expect(denialsAfterScopes(both, session, [compound])).toEqual([]);
  });

  test('a scoped denial stands without the grant', () => {
    expect(denialsAfterScopes(ctxWithGrant(null), session, [scoped])).toEqual([scoped]);
  });

  test('a mixed push keeps the structural denial and drops the granted one', () => {
    const c = ctxWithGrant({ agent: 'main', kortixCli: [ANY] });
    expect(denialsAfterScopes(c, session, [scoped, structural])).toEqual([structural]);
  });

  test('no denials means no scope is ever consulted', () => {
    // The hot path: the resolver must be reachable only through a denial, so an
    // empty list can never trigger an authorization read.
    const c = {
      get: () => {
        throw new Error('agentGrant must not be read when nothing was denied');
      },
    } as any;
    expect(denialsAfterScopes(c, session, [])).toEqual([]);
  });
});
