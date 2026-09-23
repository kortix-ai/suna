/**
 * Git proxy audit rows: `git.clone` / `git.push` with refs and old → new sha,
 * attributed to the principal (spec docs/specs/2026-09-22-agents-as-principals.md §2).
 */
import { describe, expect, test } from 'bun:test';
import { gitAuditOutcome, gitPrincipalEnvelope, gitPushRefSummary } from './audit';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('gitPushRefSummary', () => {
  test('records every ref with old → new sha and the kind of update', () => {
    expect(
      gitPushRefSummary([
        { ref: 'refs/heads/main', oldSha: A, newSha: B },
        { ref: 'refs/heads/new', oldSha: ZERO, newSha: A },
        { ref: 'refs/heads/gone', oldSha: B, newSha: ZERO },
      ]),
    ).toEqual([
      { ref: 'refs/heads/main', old_sha: A, new_sha: B, kind: 'update' },
      { ref: 'refs/heads/new', old_sha: ZERO, new_sha: A, kind: 'create' },
      { ref: 'refs/heads/gone', old_sha: B, new_sha: ZERO, kind: 'delete' },
    ]);
  });

  test('a refused ref carries the reason git printed', () => {
    const summary = gitPushRefSummary(
      [{ ref: 'refs/heads/main', oldSha: A, newSha: B }],
      new Map([['refs/heads/main', 'agent sessions may not push the default branch']]),
    );
    expect(summary[0]).toMatchObject({ denied_reason: 'agent sessions may not push the default branch' });
  });
});

describe('gitAuditOutcome', () => {
  test('2xx = success, a refused push or 401/403 = denied, anything else = failure', () => {
    expect(gitAuditOutcome(200, false)).toBe('success');
    expect(gitAuditOutcome(200, true)).toBe('denied');
    expect(gitAuditOutcome(403, false)).toBe('denied');
    expect(gitAuditOutcome(502, false)).toBe('failure');
  });
});

describe('gitPrincipalEnvelope', () => {
  test('a session credential is the agent, bound to its session', () => {
    expect(gitPrincipalEnvelope({ kind: 'session', sessionId: 's1', branch: 's1', userId: 'u1', tokenId: 't1' })).toEqual({
      actorType: 'agent',
      actorUserId: 'u1',
      sessionId: 's1',
      source: 'agent',
    });
  });
  test('a person is the human user; an account API key and a monitor box are system', () => {
    expect(gitPrincipalEnvelope({ kind: 'user', userId: 'u1', tokenId: 't1' })).toMatchObject({
      actorType: 'human',
      actorUserId: 'u1',
    });
    expect(gitPrincipalEnvelope({ kind: 'user', userId: null })).toMatchObject({ actorType: 'system', actorUserId: null });
    expect(gitPrincipalEnvelope({ kind: 'monitor' })).toMatchObject({ actorType: 'system', source: 'monitor' });
  });
});
