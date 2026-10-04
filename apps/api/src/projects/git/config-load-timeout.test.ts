// Regression for KRTX-819 (prod, 2026-10-03T11:53–12:04 UTC). One project's git
// remote hung: every mirror fetch/clone inside `loadProjectConfig` paid its full
// per-op timeout × retry ladder, so the manifest stage alone measured 542474 ms
// in the `[projects] secrets: slow read` warn — the GET /v1/projects/:id/secrets
// client was 503'd at the 25 s request deadline while the load kept running for
// another ~8.5 min. The load must be BOUNDED: reject inside the deadline with a
// retryable `GitOperationError`, so the secrets route degrades to
// `manifest_status: 'error'` and every other caller keeps the standard
// transient-git classification (retryable 503 + Retry-After, no Sentry page).

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { isTransientGitMirrorError } from './mirror';

// The git-backed file layer `loadProjectConfig` drives: a mirror refresh the
// remote never answers (hang), or a load that fails for a real (non-timeout)
// reason. Only the three names `config.ts` imports are stubbed; the real
// module is untouched for every other test file.
let failure: Error | null = null;
function stuck<T>(): Promise<T> {
  if (failure) return Promise.reject(failure);
  return new Promise<T>(() => {});
}
mock.module('./files', () => ({
  listRepoFiles: () => stuck(),
  readManifestFromRepo: () => stuck(),
  readRepoFile: () => stuck(),
}));

const { loadProjectConfig } = await import('./config');

const PROJECT = {
  projectId: '11111111-1111-4111-8111-111111111111',
  repoUrl: 'https://git.example.internal/synthetic/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

/** Rejects if `promise` has not settled — turns an unbounded hang into a
 *  countable failure instead of a test-timeout with no output. */
function failAfter<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

afterEach(() => {
  failure = null;
  delete process.env.KORTIX_PROJECT_CONFIG_TIMEOUT_MS;
});

describe('loadProjectConfig — bounded against a hung git mirror', () => {
  test('rejects in bounded time with a retryable GitOperationError', async () => {
    process.env.KORTIX_PROJECT_CONFIG_TIMEOUT_MS = '1500';
    const err: unknown = await failAfter(
      loadProjectConfig(PROJECT).then(
        () => null,
        (e) => e,
      ),
      5_000,
      'loadProjectConfig',
    );

    // Without the bound this never settles: the assertion below fails on the
    // sentinel error instead of passing on an unbounded hang.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('GitOperationError');
    expect((err as { kind?: string }).kind).toBe('timeout');
    expect((err as Error).message).toContain('timed out');
    // The bound must classify like the mirror's own per-op timeouts do:
    // retryable (503 + Retry-After), never a Sentry page.
    expect(isTransientGitMirrorError(err)).toBe(true);
  });

  test('a load error that is not a timeout propagates unchanged', async () => {
    process.env.KORTIX_PROJECT_CONFIG_TIMEOUT_MS = '5000';
    failure = new Error('synthetic manifest parse failure');
    const err: unknown = await failAfter(
      loadProjectConfig(PROJECT).then(
        () => null,
        (e) => e,
      ),
      5_000,
      'loadProjectConfig',
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toBe('synthetic manifest parse failure');
    expect(isTransientGitMirrorError(err)).toBe(false);
  });
});
