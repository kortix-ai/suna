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

describe('git proxy attribution binds into the request scope', () => {
  const { runWithContext } = require('../lib/request-context');
  const { attachInboundAuditScope } = require('../shared/audit-scope');
  const { annotateGitTransfer, bindGitProxyPrincipal } = require('./audit');
  const project = {
    projectId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
  } as never;
  const USER = '00000000-0000-4000-a000-000000000001';

  function scopeAfter(fn: () => void) {
    return runWithContext('POST', '/v1/git/p/git-receive-pack', () => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      fn();
      return scope;
    });
  }

  test('a session principal is the agent in its project, resolved late for on-behalf-of', () => {
    const scope = scopeAfter(() =>
      bindGitProxyPrincipal(
        { kind: 'session', sessionId: 'ses-1', branch: 'kortix/ses-1', userId: USER, tokenId: 'tok-1' },
        project,
      ),
    );
    expect(scope.principal).toMatchObject({
      accountId: '00000000-0000-4000-a000-000000000101',
      projectId: '00000000-0000-4000-a000-000000000201',
      sessionId: 'ses-1',
      actorType: 'agent',
      actorUserId: USER,
      authoritativeSource: 'agent',
      authMethod: { kind: 'git', principal: 'session', token_id: 'tok-1' },
    });
    expect(typeof scope.principal.lateAttribution).toBe('function');
  });

  test('a person pushing with a PAT is the human, authenticated by api key', () => {
    const scope = scopeAfter(() =>
      bindGitProxyPrincipal({ kind: 'user', userId: USER, tokenId: 'pat-1' }, project),
    );
    expect(scope.principal).toMatchObject({
      actorType: 'human',
      actorUserId: USER,
      sessionId: null,
      authoritativeSource: 'api_key',
      authMethod: { kind: 'git', principal: 'user', token_id: 'pat-1' },
    });
    expect(scope.principal.lateAttribution).toBeUndefined();
  });

  test('a monitor box is system', () => {
    const scope = scopeAfter(() => bindGitProxyPrincipal({ kind: 'monitor' }, project));
    expect(scope.principal).toMatchObject({ actorType: 'system', authoritativeSource: 'monitor' });
  });

  test('a transfer names itself as git.clone / git.push on the git repository', () => {
    const scope = scopeAfter(() =>
      annotateGitTransfer({
        action: 'git.push',
        projectId: '00000000-0000-4000-a000-000000000201',
        outcome: 'denied',
        refs: [{ ref: 'refs/heads/main', old_sha: A, new_sha: B, kind: 'update' }],
      }),
    );
    expect(scope.annotation).toEqual({
      action: 'git.push',
      resourceType: 'git_repository',
      resourceId: '00000000-0000-4000-a000-000000000201',
      outcome: 'denied',
      metadata: {
        via: 'git_proxy',
        refs: [{ ref: 'refs/heads/main', old_sha: A, new_sha: B, kind: 'update' }],
      },
    });
  });
});
