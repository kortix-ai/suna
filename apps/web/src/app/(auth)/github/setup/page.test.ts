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

  test('proves GitHub identity via the App-native OAuth flow, never the Kortix Supabase session', () => {
    const popupSource = readFileSync(
      new URL('../../auth/github-connect/page.tsx', import.meta.url),
      'utf8',
    );
    // This popup must never touch Supabase — it used to route the identity
    // proof through Supabase's separate, dual-purpose GitHub login provider,
    // which coupled account-linking uptime to unrelated login config (broke
    // in production when that provider's dashboard toggle was off). It now
    // gets the proof from the GitHub App's own OAuth client instead.
    expect(popupSource.toLowerCase()).not.toContain('supabase');
    expect(popupSource).toContain('platform/github-app/oauth/authorize');
    expect(popupSource).toContain('access_token');
  });
});
