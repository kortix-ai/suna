/**
 * One root-cause state for "Kortix can no longer reach this project's GitHub
 * repository" (KRTX-2955). The classifier reads the GitHub answer to the
 * installation-token mint; the state machine decides when to probe again.
 */
import { describe, expect, test } from 'bun:test';

import { GitHubApiError } from '../projects/github-http';
import {
  REPOSITORY_DISCONNECTED_CODE,
  RepositoryDisconnectedError,
  classifyInstallationTokenError,
  isRepositoryDisconnectedError,
  readGitHealth,
  repositoryDisconnectedBody,
  shouldProbeRepository,
  PROBE_INTERVAL_MS,
} from './repository-health';

const mint = (status: number, message: string) =>
  new GitHubApiError(
    `GitHub /app/installations/7/access_tokens failed (${status}): ${message}`,
    status,
    '/app/installations/7/access_tokens',
  );

describe('classifyInstallationTokenError', () => {
  test('404 on the mint = the App was uninstalled', () => {
    expect(classifyInstallationTokenError(mint(404, 'Not Found'))).toBe('app_uninstalled');
  });

  test('403 suspended on the mint = the App is suspended', () => {
    expect(classifyInstallationTokenError(mint(403, 'This installation has been suspended'))).toBe('app_suspended');
  });

  test('422 on a repo-scoped mint = the repository is not accessible', () => {
    expect(
      classifyInstallationTokenError(
        mint(422, 'There is at least one repository that does not exist or is not accessible to the parent installation.'),
      ),
    ).toBe('repo_not_accessible');
  });

  test('5xx, rate limits and network errors are transient', () => {
    expect(classifyInstallationTokenError(mint(502, 'Bad Gateway'))).toBe('transient');
    expect(classifyInstallationTokenError(mint(429, 'rate limited'))).toBe('transient');
    expect(classifyInstallationTokenError(new TypeError('fetch failed'))).toBe('transient');
  });

  test('other GitHub answers are not a disconnect', () => {
    // 401 = our App JWT is wrong (server config), 403 without "suspended" = a
    // permission the App lacks: neither is fixed by reinstalling.
    expect(classifyInstallationTokenError(mint(401, 'Bad credentials'))).toBe('other');
    expect(classifyInstallationTokenError(mint(403, 'Resource not accessible by integration'))).toBe('other');
  });

  test('a 404 from any other GitHub path is NOT an uninstall', () => {
    const repo404 = new GitHubApiError('GitHub /repos/o/r failed (404): Not Found', 404, '/repos/o/r');
    expect(classifyInstallationTokenError(repo404)).toBe('other');
  });
});

describe('git health state', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const stored = (overrides: Record<string, unknown> = {}) => ({
    status: 'error',
    lastErrorCode: 'app_uninstalled',
    lastValidatedAt: new Date(now),
    installationId: '7',
    ...overrides,
  });

  test('a healthy connection has no state and is always probed', () => {
    expect(readGitHealth(null)).toBeNull();
    expect(readGitHealth(stored({ status: 'connected' }))).toBeNull();
    expect(shouldProbeRepository(null, now)).toBe(true);
  });

  test('a disconnected connection is probed at most once per interval', () => {
    const health = readGitHealth(stored());
    expect(health).toEqual({ reason: 'app_uninstalled', installationId: '7', checkedAt: new Date(now) });
    expect(shouldProbeRepository(health, now + 1_000)).toBe(false);
    expect(shouldProbeRepository(health, now + PROBE_INTERVAL_MS)).toBe(true);
  });

  test('an error code that is not a disconnect reads as healthy', () => {
    expect(readGitHealth(stored({ lastErrorCode: 'something_else' }))).toBeNull();
    expect(readGitHealth(stored({ lastValidatedAt: null }))).toBeNull();
  });
});

describe('RepositoryDisconnectedError', () => {
  test('carries the stable code, the reason, and a message that names the fix', () => {
    const error = new RepositoryDisconnectedError({
      reason: 'app_uninstalled',
      repository: 'acme/app',
      installationId: '7',
    });
    expect(isRepositoryDisconnectedError(error)).toBe(true);
    expect(error.code).toBe(REPOSITORY_DISCONNECTED_CODE);
    expect(error.message).toContain('acme');
    expect(error.message).toContain('reinstall');
    const body = repositoryDisconnectedBody(error, 'https://github.com/apps/kortix/installations/new');
    expect(body).toEqual({
      error: error.message,
      code: 'repository_disconnected',
      reason: 'app_uninstalled',
      repository: 'acme/app',
      installation_id: '7',
      install_url: 'https://github.com/apps/kortix/installations/new',
    });
  });

  test('each reason has its own fix', () => {
    const msg = (reason: 'app_suspended' | 'repo_not_accessible') =>
      new RepositoryDisconnectedError({ reason, repository: 'acme/app', installationId: '7' }).message;
    expect(msg('app_suspended')).toContain('suspended');
    expect(msg('repo_not_accessible')).toContain('Repository access');
  });

  test('is recognized structurally across module copies', () => {
    expect(isRepositoryDisconnectedError({ name: 'RepositoryDisconnectedError', code: 'repository_disconnected' })).toBe(true);
    expect(isRepositoryDisconnectedError(new Error('x'))).toBe(false);
  });
});
