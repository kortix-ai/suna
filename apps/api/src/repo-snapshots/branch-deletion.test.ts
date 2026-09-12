/**
 * Deciding that a branch is DELETED, as opposed to invisible.
 *
 * GitHub answers 404 both for a ref that does not exist and for a repository
 * the credential may not see, with the same body and the same message. Getting
 * this wrong erases the recorded revision for every session on that ref, so the
 * classifier is proved against real HTTP responses rather than message strings.
 *
 * Run:
 *   cd apps/api && bun test --isolate src/repo-snapshots/branch-deletion.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GitHubApiError, getBranchCommitSha } from '../projects/github';
import { confirmBranchDeleted } from './prepare';

const auth = { token: 'fixture-token' };
/** Which repositories the credential can see. Everything else 404s, like GitHub. */
const visible = new Set(['kortix-ai/public-repo']);
let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const match = path.match(/^\/repos\/([^/]+)\/([^/]+)/);
      const slug = match ? `${match[1]}/${match[2]}` : '';
      if (!visible.has(slug)) {
        // GitHub hides a repository the token cannot see behind a plain 404 —
        // identical for the repository endpoint and the ref endpoint.
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      if (path.includes('/git/ref/heads/gone')) {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      if (path.includes('/git/ref/')) {
        return new Response(JSON.stringify({ object: { sha: 'a'.repeat(40), type: 'commit' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 12345, full_name: slug }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Compare the PARSED origin, never a string prefix: `https://api.github.com.example`
    // starts with the same characters and is a different host entirely.
    const parsed = URL.parse?.(url) ?? (() => { try { return new URL(url); } catch { return null; } })();
    if (parsed?.origin === 'https://api.github.com') {
      return realFetch(base + parsed.pathname + parsed.search, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

async function refError(owner: string, repo: string, branch: string): Promise<unknown> {
  try {
    await getBranchCommitSha({ owner, repo, branch, auth });
    throw new Error('expected a 404');
  } catch (error) {
    return error;
  }
}

describe('confirmBranchDeleted', () => {
  test('a deleted branch in a visible repository is confirmed', async () => {
    const error = await refError('kortix-ai', 'public-repo', 'gone');
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(404);
    expect(await confirmBranchDeleted({ error, owner: 'kortix-ai', repo: 'public-repo', auth })).toBe(true);
  });

  test('a repository the credential cannot see is NOT a deleted branch', async () => {
    const error = await refError('kortix-ai', 'private-repo', 'main');
    // The message is indistinguishable from the deletion above — this is the
    // exact string the old wording-based classifier accepted.
    expect((error as Error).message).toContain('404');
    expect((error as Error).message).toContain('Not Found');
    expect(await confirmBranchDeleted({ error, owner: 'kortix-ai', repo: 'private-repo', auth })).toBe(false);
  });

  test('a 404 from any other endpoint is not a branch answer', async () => {
    const error = new GitHubApiError('GitHub /repos/kortix-ai/public-repo failed (404): Not Found', 404, '/repos/kortix-ai/public-repo');
    expect(await confirmBranchDeleted({ error, owner: 'kortix-ai', repo: 'public-repo', auth })).toBe(false);
  });

  test('a non-404 failure never confirms deletion', async () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const error = new GitHubApiError(`GitHub ref failed (${status})`, status, '/repos/kortix-ai/public-repo/git/ref/heads/main');
      expect(await confirmBranchDeleted({ error, owner: 'kortix-ai', repo: 'public-repo', auth })).toBe(false);
    }
  });

  test('a plain Error never confirms deletion', async () => {
    expect(
      await confirmBranchDeleted({
        error: new Error('404 not found'),
        owner: 'kortix-ai',
        repo: 'public-repo',
        auth,
      }),
    ).toBe(false);
  });

  test('an existing branch produces no error at all', async () => {
    expect(await getBranchCommitSha({ owner: 'kortix-ai', repo: 'public-repo', branch: 'main', auth })).toBe(
      'a'.repeat(40),
    );
  });
});
