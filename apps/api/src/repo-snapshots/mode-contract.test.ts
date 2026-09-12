/**
 * Mode contract. Each mode is a promise about BEHAVIOUR, and each of these
 * pins one:
 *
 *   off       nothing resolves; the legacy path is untouched.
 *   shadow    a pin may resolve, but it never GOVERNS — the session keeps
 *             Git-backed reads, the Git hint, and create-time authoring.
 *   prefer    a ready artifact governs; a miss falls back and is counted.
 *   required  no automatic fallback. An eligible GitHub start fails closed,
 *             including when storage is not configured at all.
 *
 * The policy is scoped to GitHub-backed projects. A project of any other kind
 * must keep working under every mode, `required` included.
 */
import { describe, expect, test } from 'bun:test';

import { resolveRepoSnapshotMode } from './descriptor';

describe('mode resolution', () => {
  test('an unconfigured bucket degrades best-effort modes to off', () => {
    // Nothing can be served, and both modes are best-effort by definition.
    expect(resolveRepoSnapshotMode('shadow', false)).toBe('off');
    expect(resolveRepoSnapshotMode('prefer', false)).toBe('off');
    expect(resolveRepoSnapshotMode('off', false)).toBe('off');
  });

  test('required is NEVER silently degraded by a missing bucket', () => {
    // An operator who asked to fail closed must not be switched to the Git
    // path by a missing environment variable. Every eligible start then
    // reports the misconfiguration, which is visible; a silent downgrade is not.
    expect(resolveRepoSnapshotMode('required', false)).toBe('required');
  });

  test('a configured bucket preserves the requested mode', () => {
    for (const mode of ['off', 'shadow', 'prefer', 'required'] as const) {
      expect(resolveRepoSnapshotMode(mode, true)).toBe(mode);
    }
  });
});

describe('required-mode failure policy', () => {
  async function failureFor(miss: unknown, mode = 'required') {
    const { requiredModeFailure } = await import('./session-pin');
    return requiredModeFailure({ pinned: false, mode, miss } as never);
  }

  test('a GitHub project that is not prepared yet is retryable', async () => {
    const failure = await failureFor({ reason: 'not_prepared', commitSha: 'a'.repeat(40) });
    expect(failure?.status).toBe(503);
    expect(failure?.code).toBe('REPO_SNAPSHOT_PREPARING');
    expect(failure?.retryable).toBe(true);
  });

  test('a failed preparation is retryable and names the reason', async () => {
    const failure = await failureFor({
      reason: 'failed',
      commitSha: 'b'.repeat(40),
      detail: 'KORTIX_REPO_SNAPSHOT_BUCKET is unset, so no snapshot can be served',
    });
    expect(failure?.status).toBe(503);
    expect(failure?.code).toBe('REPO_SNAPSHOT_PREPARATION_FAILED');
    expect(failure?.message).toContain('BUCKET is unset');
  });

  test('a GitHub project that can never be prepared fails closed, not retryably', async () => {
    const failure = await failureFor({
      reason: 'unsupported_project',
      detail: 'project has no resolvable GitHub owner/repo',
      githubBacked: true,
    });
    expect(failure?.status).toBe(409);
    expect(failure?.retryable).toBe(false);
  });

  test('a NON-GitHub project is out of scope and keeps working', async () => {
    // The policy governs GitHub-backed projects. Failing a GitLab or generic
    // project closed would take an unrelated project type down with a flag
    // that was never meant to govern it.
    const failure = await failureFor({
      reason: 'unsupported_project',
      detail: 'provider gitlab is not GitHub',
      githubBacked: false,
    });
    expect(failure).toBeNull();
  });

  test('no mode other than required ever fails a start', async () => {
    for (const mode of ['off', 'shadow', 'prefer']) {
      expect(await failureFor({ reason: 'not_prepared', commitSha: 'c'.repeat(40) }, mode)).toBeNull();
      expect(await failureFor({ reason: 'disabled' }, mode)).toBeNull();
    }
    // `disabled` is not a failure even in required: the feature is off.
    expect(await failureFor({ reason: 'disabled' })).toBeNull();
  });
});

describe('shadow never governs', () => {
  async function pinFor(mode: string) {
    // `governs` is a pure function of the mode, so this pins the rule without
    // needing a database, a bucket, or a project fixture.
    const { requiredModeFailure } = await import('./session-pin');
    return { requiredModeFailure, mode };
  }

  test('governs is true only for prefer and required', async () => {
    const governs = (mode: string) => mode === 'prefer' || mode === 'required';
    expect(governs('off')).toBe(false);
    expect(governs('shadow')).toBe(false);
    expect(governs('prefer')).toBe(true);
    expect(governs('required')).toBe(true);
    // Mirrors `session-pin.ts`; the source-level pin that this expression IS
    // the one used lives in sessions.fast-boot-git-hint.test.ts.
    const source = await Bun.file(new URL('./session-pin.ts', import.meta.url)).text();
    expect(source).toContain("governs: mode === 'prefer' || mode === 'required',");
    await pinFor('shadow');
  });
});
