/**
 * A dead account connection reads as a reconnect prompt, never as a raw GitHub
 * string.
 *
 * `POST /app/installations/<id>/access_tokens` 404s whenever the installation
 * does not belong to the App that signed the JWT. That is what EVERY stored
 * connection looks like the moment the instance App identity changes — all 39
 * accounts on 2026-09-16 — and what an uninstall looks like too.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHubApiError } from '../github';
import {
  githubInstallationUnreachableBody,
  isGitHubInstallationUnreachable,
} from './github-installation-errors';

describe('isGitHubInstallationUnreachable', () => {
  test('recognizes a 404 from the token mint', () => {
    const error = new GitHubApiError(
      'GitHub /app/installations/84/access_tokens failed (404): Not Found',
      404,
      '/app/installations/84/access_tokens',
    );
    expect(isGitHubInstallationUnreachable(error)).toBe(true);
  });

  test('ignores a 404 from any other path', () => {
    const error = new GitHubApiError('GitHub /repos/acme/portal failed (404)', 404, '/repos/acme/portal');
    expect(isGitHubInstallationUnreachable(error)).toBe(false);
  });

  test('ignores a non-404 on the token mint', () => {
    const error = new GitHubApiError(
      'GitHub /app/installations/84/access_tokens failed (403)',
      403,
      '/app/installations/84/access_tokens',
    );
    expect(isGitHubInstallationUnreachable(error)).toBe(false);
  });

  test('ignores an ordinary error', () => {
    expect(isGitHubInstallationUnreachable(new Error('boom'))).toBe(false);
  });
});

describe('githubInstallationUnreachableBody', () => {
  test('says what happened and where to fix it, with no GitHub text', () => {
    const body = githubInstallationUnreachableBody('84', 'https://github.com/apps/kortix/installations/new');

    expect(body).toEqual({
      error: 'github_installation_unreachable',
      message: 'This GitHub connection is no longer valid. Reconnect it in Settings → Git.',
      installation_id: '84',
      install_url: 'https://github.com/apps/kortix/installations/new',
    });
    expect(body.message).not.toContain('404');
    expect(body.message).not.toContain('GitHub /app');
  });
});

describe('every route that mints an installation token maps it', () => {
  // A predicate nobody calls protects nobody. These are the three surfaces a
  // user reaches with a stale connection: browse repositories, browse
  // branches, and create or link a repository.
  const routes = ['routes/github-repositories.ts', 'routes/r2.ts'];

  for (const route of routes) {
    test(`${route} maps the unreachable installation`, () => {
      const source = readFileSync(join(import.meta.dir, '..', route), 'utf8');
      expect(source).toContain('isGitHubInstallationUnreachable');
      expect(source).toContain('githubInstallationUnreachableBody');
    });
  }

  test('github-repositories.ts maps it on BOTH of its routes', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'routes/github-repositories.ts'),
      'utf8',
    );
    const occurrences = source.split('isGitHubInstallationUnreachable(').length - 1;
    expect(occurrences).toBe(2);
  });
});
