/**
 * `resolveGitHubImportWithPat` refuses a token that cannot push. A GitHub App
 * installation token reads `permissions.push: false` on every repository, so
 * the App path (repository replacement) proves write access from the
 * installation's own permissions and skips this check.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveGitHubImportWithPat } from '../projects/lib/git';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function githubAnswersReadOnly() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = href.includes('/branches/')
      ? { name: 'main', commit: { sha: 'a'.repeat(40) } }
      : { full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, default_branch: 'main', private: true, permissions: { pull: true, push: false, admin: false } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('resolveGitHubImportWithPat push check', () => {
  test('a token that reads push: false is refused', async () => {
    githubAnswersReadOnly();
    await expect(resolveGitHubImportWithPat({ repoUrl: 'https://github.com/acme/app.git', token: 'ghp_x' })).rejects.toThrow('lacks write (push) access');
  });

  test('a caller that proved write access elsewhere (App installation) is not refused', async () => {
    githubAnswersReadOnly();
    const result = await resolveGitHubImportWithPat({ repoUrl: 'https://github.com/acme/app.git', token: 'ghs_x', pushVerified: true });
    expect(result.repo.full_name).toBe('acme/app');
    expect(result.defaultBranch).toBe('main');
  });
});
