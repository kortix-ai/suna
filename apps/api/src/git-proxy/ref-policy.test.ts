/**
 * The invariant under test: a session can only ever move its own branch, and
 * only a human can move anything else.
 *
 * Each `session` case below is a push that SUCCEEDED against dev on
 * 2026-08-31 with nothing but a sandbox token — including force-rewinding
 * `main` to its root commit — and must now be refused.
 */
import { describe, expect, test } from 'bun:test';
import { evaluateRefUpdates, principalLabel, type GitPrincipal } from './ref-policy';
import type { RefUpdate } from './receive-pack';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SESSION_ID = '9bf3acd4-85bc-46fe-a938-e61404e00270';

const ctx = { defaultBranch: 'main' };
const session: GitPrincipal = { kind: 'session', sessionId: SESSION_ID, branch: SESSION_ID };
const monitor: GitPrincipal = { kind: 'monitor' };
const user: GitPrincipal = { kind: 'user', userId: 'user-1' };
const internal: GitPrincipal = { kind: 'internal' };

const update = (ref: string, oldSha = A, newSha = B): RefUpdate => ({ ref, oldSha, newSha });
const create = (ref: string): RefUpdate => update(ref, ZERO, B);
const remove = (ref: string): RefUpdate => update(ref, A, ZERO);

describe('session principal', () => {
  test('may fast-forward its own branch', () => {
    expect(evaluateRefUpdates(session, ctx, [update(`refs/heads/${SESSION_ID}`)])).toEqual([]);
  });

  test('may create its own branch', () => {
    expect(evaluateRefUpdates(session, ctx, [create(`refs/heads/${SESSION_ID}`)])).toEqual([]);
  });

  test('may force-push its own branch', () => {
    // The starter skill instructs agents to `--force-with-lease` their own
    // branch after the platform advances it; that must keep working.
    const forced = update(`refs/heads/${SESSION_ID}`, B, A);
    expect(evaluateRefUpdates(session, ctx, [forced])).toEqual([]);
  });

  test('may NOT delete its own branch — it is an open CR head', () => {
    const denials = evaluateRefUpdates(session, ctx, [remove(`refs/heads/${SESSION_ID}`)]);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toContain('may not delete');
  });

  test.each([
    ['the default branch', 'refs/heads/main'],
    ['a long-lived trunk that is not the default branch', 'refs/heads/dev'],
    ['another session branch', 'refs/heads/11111111-2222-3333-4444-555555555555'],
    ['an arbitrary feature branch', 'refs/heads/totally-unrelated-branch'],
    ['a tag', 'refs/tags/v1.0.0'],
    ['a branch whose name merely starts with the session id', `refs/heads/${SESSION_ID}-evil`],
    ['a nested branch under the session id', `refs/heads/${SESSION_ID}/sub`],
  ])('may NOT push %s', (_label, ref) => {
    const denials = evaluateRefUpdates(session, ctx, [update(ref)]);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.ref).toBe(ref);
    expect(denials[0]!.reason).toContain('own branch');
  });

  test('may NOT force-rewind main — the exact push that succeeded on dev', () => {
    const rewind = update('refs/heads/main', B, A);
    expect(evaluateRefUpdates(session, ctx, [rewind])).toHaveLength(1);
  });

  test('may NOT delete another branch', () => {
    expect(evaluateRefUpdates(session, ctx, [remove('refs/heads/master')])).toHaveLength(1);
  });

  test('a mixed push reports every denied ref, and only those', () => {
    const denials = evaluateRefUpdates(session, ctx, [
      update(`refs/heads/${SESSION_ID}`),
      update('refs/heads/main'),
      update('refs/heads/dev'),
    ]);
    expect(denials.map((d) => d.ref)).toEqual(['refs/heads/main', 'refs/heads/dev']);
  });

  test('the reason names the branch the session may use, so an agent can recover', () => {
    const [denial] = evaluateRefUpdates(session, ctx, [update('refs/heads/main')]);
    expect(denial!.reason).toContain(SESSION_ID);
    expect(denial!.reason).toContain('change request');
    // git prints the reason on one line, in parentheses.
    expect(denial!.reason).not.toContain('\n');
  });

  test('a session whose branch IS the default branch still only gets that ref', () => {
    // Defensive: nothing mints such a session today, but the rule must not
    // accidentally widen if one ever appears.
    const odd: GitPrincipal = { kind: 'session', sessionId: SESSION_ID, branch: 'main' };
    expect(evaluateRefUpdates(odd, ctx, [update('refs/heads/main')])).toEqual([]);
    expect(evaluateRefUpdates(odd, ctx, [update('refs/heads/dev')])).toHaveLength(1);
  });
});

describe('monitor principal', () => {
  test.each([
    ['its own-looking branch', 'refs/heads/anything'],
    ['the default branch', 'refs/heads/main'],
  ])('may NOT push %s — monitor boxes are read-only', (_label, ref) => {
    const denials = evaluateRefUpdates(monitor, ctx, [update(ref)]);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toContain('read-only');
  });
});

describe('user principal', () => {
  test.each([
    ['the default branch', 'refs/heads/main'],
    ['a feature branch', 'refs/heads/feature'],
    ['a tag', 'refs/tags/v1.0.0'],
    ['a session branch', `refs/heads/${SESSION_ID}`],
  ])('may push %s — a human at a laptop keeps ordinary git', (_label, ref) => {
    expect(evaluateRefUpdates(user, ctx, [update(ref)])).toEqual([]);
  });

  test('deleting a non-default branch is stated as needing the delete scope', () => {
    // The POLICY asks one question for every principal; ref-scopes.ts is what
    // answers "a person holds it", so a human is unaffected in practice.
    const [denial] = evaluateRefUpdates(user, ctx, [remove('refs/heads/stale')]);
    expect(denial!.requires).toEqual(['project.gitops.ref.delete']);
  });

  test('may NOT delete the default branch', () => {
    const denials = evaluateRefUpdates(user, ctx, [remove('refs/heads/main')]);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toContain('cannot be deleted');
  });

  test('the default branch is read from the project, not hardcoded to main', () => {
    const devDefault = { defaultBranch: 'dev' };
    // `dev` is the default here, so its deletion hits the structural floor...
    const [floor] = evaluateRefUpdates(user, devDefault, [remove('refs/heads/dev')]);
    expect(floor!.requires).toBeUndefined();
    expect(floor!.reason).toContain('cannot be deleted');
    // ...while `main` is now an ordinary branch, deletable with the scope.
    const [ordinary] = evaluateRefUpdates(user, devDefault, [remove('refs/heads/main')]);
    expect(ordinary!.requires).toEqual(['project.gitops.ref.delete']);
  });

  test('force-push is NOT judged here — it is not decidable without the pack', () => {
    // Ancestry lives in objects the proxy has not received. The upstream
    // ruleset owns this; the policy must not pretend to answer it.
    expect(evaluateRefUpdates(user, ctx, [update('refs/heads/main', B, A)])).toEqual([]);
  });
});

describe('internal principal', () => {
  test('may move any ref — server-side writers are gated at their own routes', () => {
    expect(evaluateRefUpdates(internal, ctx, [update('refs/heads/main')])).toEqual([]);
  });

  test('still cannot delete the default branch — that floor is absolute', () => {
    const denials = evaluateRefUpdates(internal, ctx, [remove('refs/heads/main')]);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.requires).toBeUndefined();
  });
});

describe('the two authority layers', () => {
  test('a session denial names the scope that would widen it', () => {
    const [other] = evaluateRefUpdates(session, ctx, [update('refs/heads/dev')]);
    expect(other!.requires).toEqual(['project.gitops.ref.any']);
    const [own] = evaluateRefUpdates(session, ctx, [remove(`refs/heads/${SESSION_ID}`)]);
    expect(own!.requires).toEqual(['project.gitops.ref.delete']);
    // Deleting ANOTHER ref needs both — one leaf could never express this.
    const [both] = evaluateRefUpdates(session, ctx, [remove('refs/heads/other')]);
    expect(both!.requires).toEqual(['project.gitops.ref.any', 'project.gitops.ref.delete']);
  });

  test('a STRUCTURAL denial names no scope, so nothing can grant past it', () => {
    // The default-branch floor, for a principal that could otherwise delete refs.
    const [floor] = evaluateRefUpdates(user, ctx, [remove('refs/heads/main')]);
    expect(floor!.requires).toBeUndefined();
    // A monitor has no principal behind it to hold a scope.
    const [mon] = evaluateRefUpdates(monitor, ctx, [update('refs/heads/x')]);
    expect(mon!.requires).toBeUndefined();
  });

  test('the default-branch floor outranks a delete scope for a session too', () => {
    const [denial] = evaluateRefUpdates(session, ctx, [remove('refs/heads/main')]);
    expect(denial!.requires).toBeUndefined();
    expect(denial!.reason).toContain('cannot be deleted');
  });
});

describe('evaluateRefUpdates', () => {
  test('an empty push denies nothing', () => {
    expect(evaluateRefUpdates(session, ctx, [])).toEqual([]);
  });
});

describe('principalLabel', () => {
  test('never leaks a branch name, which can carry user content', () => {
    const evil: GitPrincipal = { kind: 'session', sessionId: SESSION_ID, branch: 'secret-name' };
    expect(principalLabel(evil)).toBe(`session:${SESSION_ID}`);
    expect(principalLabel(evil)).not.toContain('secret-name');
  });

  test('labels every principal kind', () => {
    expect(principalLabel(monitor)).toBe('monitor');
    expect(principalLabel(user)).toBe('user:user-1');
    expect(principalLabel({ kind: 'user', userId: null })).toBe('user');
    expect(principalLabel(internal)).toBe('internal');
  });
});
