import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentConfigEtag } from './compile-agent-config';
import {
  classifyAgentFiles,
  isConfigStale,
  reloadDetail,
  reloadNeedsAttention,
  type ReloadAgentFiles,
} from './session-reload';

describe('agentConfigEtag', () => {
  test('the same config hashes the same, a changed one does not', () => {
    const a = '{"agent":{"support":{"prompt":"v1"}}}';
    expect(agentConfigEtag(a)).toBe(agentConfigEtag(a));
    expect(agentConfigEtag(a)).not.toBe(agentConfigEtag('{"agent":{"support":{"prompt":"v2"}}}'));
  });

  test('no compiled config has no etag — not the hash of "null"', () => {
    // A v1 project has nothing to compare. Hashing the absence would give every
    // v1 project the same non-null etag and make "stale" answerable when it
    // is not.
    expect(agentConfigEtag(null)).toBeNull();
    expect(agentConfigEtag(undefined)).toBeNull();
    expect(agentConfigEtag('')).toBeNull();
  });

  test('it is short enough to read and long enough to compare', () => {
    expect(agentConfigEtag('{"agent":{}}')).toHaveLength(16);
    expect(agentConfigEtag('{"agent":{}}')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('isConfigStale', () => {
  test('different hashes are stale, identical ones are not', () => {
    expect(isConfigStale('aaaa', 'bbbb')).toBe(true);
    expect(isConfigStale('aaaa', 'aaaa')).toBe(false);
  });

  test('an unknown side is null, NEVER false', () => {
    // "Up to date" and "could not ask" are different answers, and collapsing
    // them is exactly how a stale session goes unnoticed: an unreachable box
    // would report itself current. The CLI prints a warning for null rather
    // than a green tick.
    expect(isConfigStale(null, 'bbbb')).toBeNull();
    expect(isConfigStale('aaaa', null)).toBeNull();
    expect(isConfigStale(null, null)).toBeNull();
  });

  test('a project with no compiled config is unanswerable, not "current"', () => {
    // v1 projects compile to null on both sides.
    expect(isConfigStale(agentConfigEtag(null), agentConfigEtag(null))).toBeNull();
  });
});

/**
 * The workspace half of a reload — and the one thing it must never do.
 *
 * `base=1` routes the daemon to `syncWorkspaceToBase`, whose entire body is
 * `git checkout -B <cfg.branchName> <baseSha>` — and `cfg.branchName` is the
 * SESSION ID. On a session carrying commits of its own that force-moves the
 * working branch onto the base tip, orphaning them and deleting the files they
 * introduced, while the call still returns 200 and the UI says "Reloaded."
 *
 * The helper documents the precondition it needs — "safe because a fresh
 * session has no local work yet" — and its only other caller honours it, at
 * session CREATE on a restored warm snapshot. A reload runs against an
 * established session, so it must use the `--ff-only` path, which cannot
 * discard anything and fails cleanly on a branch that was never pushed.
 *
 * The obvious mitigation — gate the reset on "does this session have local
 * commits" — is not available: the API can only inspect the git mirror, and a
 * session branch committed but never pushed is not in it, so the check would
 * answer "no local work" for exactly the session with the most to lose.
 *
 * Asserted against the source because the function is private and closes over
 * `db`, `resolveSandboxIngress` and `fetch` with no injection seam. That is a
 * real limit: this pins the query and the response field, not the round trip.
 */
const SOURCE = readFileSync(join(import.meta.dir, 'session-reload.ts'), 'utf8');

function refreshBody(): string {
  // `\n}\n`, not `\n}` — the function's multi-line return type closes with
  // `\n}> {`, so the looser delimiter cuts the body off at the signature and
  // every assertion below passes vacuously.
  const body = SOURCE.split('async function refreshSandboxWorkspace(')[1]?.split('\n}\n')[0];
  expect(body).toBeTruthy();
  expect(body).toContain('/kortix/refresh');
  return body as string;
}

describe('the reload never hard-resets the session branch', () => {
  test('it does NOT send base=1 — that path destroys committed session work', () => {
    const body = refreshBody();
    expect(body).not.toContain("base: '1'");
    expect(body).not.toContain('base=1');
    expect(body).not.toContain('base_sha');
  });

  test('it uses the plain refresh, which is git pull --ff-only', () => {
    // --ff-only is the whole safety property: it refuses rather than discards.
    expect(refreshBody()).toContain('/kortix/refresh?restart=0');
  });

  test('it does not resolve a base sha at all — nothing on this path needs one', () => {
    // Belt and braces: no base sha in scope means no way to reintroduce the
    // reset by wiring an existing local back into the query.
    expect(refreshBody()).not.toContain('resolveCommitSha');
  });

  test('both entry points drop the mirror TTL before reading it', () => {
    // The mirror caches for 60s. "I merged, now reload" happens inside that
    // window essentially every time, so without this the reload compiles the
    // pre-merge manifest and `--status` cheerfully agrees you are up to date.
    // `\n}\n` — a closing brace alone on a line. Splitting on `\n}` alone stops
    // at the end of the destructured input TYPE (`\n}): Promise<…>`), which cuts
    // the body off entirely and makes this pass for the wrong reason.
    const bodyOf = (name: string) =>
      SOURCE.split(`export async function ${name}(`)[1]?.split('\n}\n')[0];
    for (const name of ['reloadSessionConfig', 'latestAgentConfigEtag']) {
      const body = bodyOf(name);
      expect(body).toBeTruthy();
      expect(body).toContain('invalidateProjectMirror(input.projectId)');
    }
  });

  test('the commit is read from repo.after, the field the daemon actually sends', () => {
    // The daemon answers `{repo: {before, after}}`. Reading `repo.commit` gave
    // undefined every time, so `commit_sha` always reported the PRE-reload value
    // and a successful pull looked like a no-op.
    const body = refreshBody();
    expect(body).toContain('body.repo?.after?.commit');
    expect(body).not.toContain('body.repo?.commit');
  });
});

/**
 * The sentence the user is told.
 *
 * This existed as one unconditional string — "Reloaded. The next prompt runs the
 * new config." — and it was measurably false on dev: the etag moved, opencode
 * kept reading the working tree's agent `.md`, and the reload reported success.
 * The rule these tests encode is that we may only claim the agent changed when
 * the files opencode actually reads were brought forward.
 */
describe('classifyAgentFiles', () => {
  test('every daemon answer maps to exactly one outcome', () => {
    const c = classifyAgentFiles;
    expect(c({ requested: true, synced: true })).toBe('updated');
    expect(c({ requested: true, synced: false, reason: 'already matches base' })).toBe(
      'already-current',
    );
    expect(c({ requested: true, synced: false, reason: 'local changes' })).toBe('kept-yours');
    expect(c({ requested: true, synced: false, reason: 'local commits' })).toBe('kept-yours');
    expect(c({ requested: true, synced: false, reason: 'no tracked config dir' })).toBe(
      'not-applicable',
    );
    expect(c({ requested: true, synced: false, reason: 'not in base' })).toBe('not-applicable');
    expect(c({ requested: true, synced: null })).toBe('unknown');
  });

  test('refresh_repo:false is "not-requested", NOT "could not confirm"', () => {
    // These were the same `null` before. One means an old sandbox could not
    // answer; the other means we deliberately never asked. Telling a user who
    // passed --no-repo that their sandbox "could not confirm" is a fabrication.
    expect(classifyAgentFiles({ requested: false, synced: null })).toBe('not-requested');
  });

  test('an unrecognised skip reason degrades to unknown, never to a success', () => {
    // 'fetch failed' / 'checkout failed' / anything added later. We cannot claim
    // the agent changed, and we must not claim the user's version was kept.
    for (const reason of ['fetch failed', 'checkout failed', 'something new', undefined]) {
      expect(classifyAgentFiles({ requested: true, synced: false, reason })).toBe('unknown');
    }
  });
});

describe('reloadDetail', () => {
  const base = {
    applied: true,
    previous_etag: 'aaaa',
    etag: 'bbbb',
    repo_refreshed: true,
    commit_sha: null,
  } as const;

  test('claims the agent changed ONLY for "updated"', () => {
    expect(reloadDetail({ ...base, agent_files: 'updated' })).toBe(
      'Reloaded. The next prompt runs the new config.',
    );
    const others: ReloadAgentFiles[] = [
      'already-current',
      'kept-yours',
      'not-applicable',
      'not-requested',
      'unknown',
    ];
    for (const agent_files of others) {
      expect(reloadDetail({ ...base, agent_files })).not.toContain(
        'The next prompt runs the new config',
      );
    }
  });

  test('a session that edited its own agent is told ITS version was kept', () => {
    expect(reloadDetail({ ...base, agent_files: 'kept-yours' })).toContain('YOUR version');
  });

  test('--no-repo says the refresh was skipped, not that the box failed', () => {
    const detail = reloadDetail({ ...base, agent_files: 'not-requested' });
    expect(detail).toContain('repo refresh was skipped');
    expect(detail).not.toContain('could not confirm');
  });

  test('a non-applied reload reports the reason and nothing about the agent', () => {
    expect(
      reloadDetail({
        ...base,
        applied: false,
        agent_files: 'unknown',
        reason: 'no reachable sandbox',
      }),
    ).toBe('Nothing to apply: no reachable sandbox.');
  });
});

describe('reloadNeedsAttention', () => {
  const base = {
    applied: true,
    previous_etag: 'aaaa',
    etag: 'bbbb',
    repo_refreshed: true,
    commit_sha: null,
  } as const;

  test('the three success outcomes are NOT warnings', () => {
    // The first thing the review caught: warning on "already current" and on a
    // project that simply keeps no agent files, both of which are fine.
    for (const agent_files of ['updated', 'already-current', 'not-applicable'] as const) {
      expect(reloadNeedsAttention({ ...base, agent_files })).toBe(false);
    }
  });

  test('kept-yours and unknown ARE warnings — the agent may not have changed', () => {
    for (const agent_files of ['kept-yours', 'unknown'] as const) {
      expect(reloadNeedsAttention({ ...base, agent_files })).toBe(true);
    }
  });

  test('a non-applied reload always needs attention', () => {
    expect(
      reloadNeedsAttention({ ...base, applied: false, agent_files: 'updated' }),
    ).toBe(true);
  });
});
