import { describe, expect, test } from 'bun:test';

import { GitHubApiError } from '../projects/github';
import { mapGitHubOperationError } from '../projects/routes/github-errors';

describe('GitHub provider error contract', () => {
  test.each([
    [403, 'github_insufficient_permissions', 403],
    [404, 'github_repository_not_found', 404],
    [422, 'github_provider_failed', 502],
  ] as const)('maps GitHub %i to %s', (upstreamStatus, code, status) => {
    const result = mapGitHubOperationError(
      new GitHubApiError('provider detail', upstreamStatus, '/repos/acme/console'),
    );
    expect(result).toMatchObject({
      status,
      body: {
        code,
      },
    });
    expect(result.body.error).not.toContain('/repos/acme/console');
  });

  test('preserves Retry-After for GitHub 429', () => {
    const result = mapGitHubOperationError(
      new GitHubApiError('rate limited', 429, '/search/repositories', '17'),
    );
    expect(result).toEqual({
      status: 429,
      retryAfter: '17',
      body: {
        error: 'GitHub rate-limited the request.',
        code: 'github_provider_rate_limited',
      },
    });
  });
});
