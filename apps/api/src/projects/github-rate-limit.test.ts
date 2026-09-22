// GitHub's secondary rate limit on repository creation (403 "You have exceeded
// a secondary rate limit ... temporarily blocked from content creation") blocked
// preview provisioning for minutes on 2026-09-22 (runs 35713379676, 35715183384).
// The API answered 502 with GitHub's text and dropped GitHub's wait. A caller
// cannot back off correctly without it.
import { afterEach, describe, expect, test } from 'bun:test';

import { GitHubApiError, createRepo, githubRetryAfterSeconds } from './github';
import { createRepoFailureResult } from './provision-core';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SECONDARY =
  'You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later.';

describe('githubRetryAfterSeconds', () => {
  const now = Date.parse('2026-09-22T10:16:33Z');

  test('Retry-After seconds win', () => {
    const h = new Headers({ 'retry-after': '45' });
    expect(githubRetryAfterSeconds(403, h, SECONDARY, now)).toBe(45);
  });

  test('x-ratelimit-reset is used when remaining is 0', () => {
    const h = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) });
    expect(githubRetryAfterSeconds(403, h, 'API rate limit exceeded', now)).toBe(120);
  });

  test('a secondary rate limit with no header waits GitHub\'s documented 60 s', () => {
    expect(githubRetryAfterSeconds(403, new Headers(), SECONDARY, now)).toBe(60);
  });

  test('429 with no header also waits 60 s', () => {
    expect(githubRetryAfterSeconds(429, new Headers(), 'Too Many Requests', now)).toBe(60);
  });

  test('a plain permission 403 is not a rate limit', () => {
    expect(githubRetryAfterSeconds(403, new Headers(), 'Resource not accessible by integration', now)).toBeNull();
  });
});

describe('ghFetch carries the GitHub wait on GitHubApiError', () => {
  test('createRepo rejects with rateLimited + retryAfterSeconds from the response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: SECONDARY }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'retry-after': '75' },
      })) as unknown as typeof fetch;

    const error = await createRepo({
      name: 'repo',
      owner: 'managed-kortix',
      auth: { token: 't', source: 'app_installation', owner: 'managed-kortix', ownerType: 'Organization' },
    } as never).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(403);
    expect((error as GitHubApiError).retryAfterSeconds).toBe(75);
  });
});

describe('createRepoFailureResult', () => {
  test('a GitHub rate limit answers 503 + Retry-After + code, not 502', () => {
    const result = createRepoFailureResult(
      new GitHubApiError(`GitHub /orgs/o/repos failed (403): ${SECONDARY}`, 403, '/orgs/o/repos', 75),
    );
    expect(result.status).toBe(503);
    expect(result.headers).toEqual({ 'Retry-After': '75' });
    expect(result.body).toMatchObject({ code: 'GITHUB_RATE_LIMITED', retry_after_seconds: 75 });
  });

  test('any other create failure stays 502 with no Retry-After', () => {
    const result = createRepoFailureResult(
      new GitHubApiError('GitHub /orgs/o/repos failed (403): Resource not accessible by integration', 403, '/orgs/o/repos'),
    );
    expect(result.status).toBe(502);
    expect(result.headers).toBeUndefined();
  });
});
