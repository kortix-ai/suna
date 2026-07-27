import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');

describe('GitHub Nango setup compatibility page', () => {
  test('starts account and reconnect sessions through the shared Nango hook', () => {
    expect(source).toContain('useGitHubNangoConnect');
    expect(source).toContain("searchParams.get('account_id')");
    expect(source).toContain("searchParams.get('reconnect_installation_id')");
    expect(source).toContain('githubConnect.start(reconnectInstallationId || undefined)');
  });

  test('does not request Supabase GitHub proof or call legacy installation routes', () => {
    expect(source).not.toContain('requestGitHubUserProof');
    expect(source).not.toContain('github_user_token');
    expect(source).not.toContain('listLinkableGitHubInstallations');
    expect(source).not.toContain('linkGitHubInstallation');
    expect(source).not.toContain('saveGitHubInstallation');
    expect(source).not.toContain('/auth/github-connect');
  });

  test('keeps close, retry, organization approval, and safe return behavior visible', () => {
    expect(source).toContain('Allow pop-ups');
    expect(source).toContain('Try again');
    expect(source).toContain('GitHub organization owner');
    expect(source).toContain('consumeGitHubSetupReturn');
    expect(source).toContain("value.startsWith('//')");
  });
});
