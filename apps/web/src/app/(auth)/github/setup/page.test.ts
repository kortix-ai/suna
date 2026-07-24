import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');

describe('GitHub installation setup', () => {
  test('requires a GitHub user proof before saving the installation', () => {
    expect(source).toContain('Verify with GitHub');
    expect(source).toContain('requestGitHubUserProof');
    expect(source).toContain('github_user_token: githubUserToken');
  });

  test('lists and links an existing installation without relying on the GitHub Configure redirect', () => {
    expect(source).toContain('listLinkableGitHubInstallations');
    expect(source).toContain('linkGitHubInstallation');
    expect(source).toContain('Select a GitHub account');
    expect(source).toContain('Install GitHub App');
    expect(source).toContain("searchParams.get('account_id')");
  });

  test('keeps the GitHub OAuth session separate from the Kortix session', () => {
    const popupSource = readFileSync(
      new URL('../../auth/github-connect/page.tsx', import.meta.url),
      'utf8',
    );
    expect(popupSource).toContain('createEphemeralOAuthClient');
    expect(popupSource).toContain("scopes: 'read:user read:org'");
  });
});
