import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';

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
    // The install action is named after the product it installs — the same
    // words the account Git tab's "Add a GitHub account" dialog uses.
    expect(source).toContain('Install the Kortix App');
    expect(source).toContain("searchParams.get('account_id')");
  });

  /**
   * The backend used to send a FAILED account link to
   * `/accounts/<id>?tab=git&github=error&reason=<slug>`. There is no
   * `/accounts` route, so the only explanation of what went wrong landed on a
   * 404. It redirects back here now, and this page owns the error state.
   */
  test('renders github=error as a state of its own, with a reason it can explain', () => {
    expect(source).toContain("searchParams.get('github') === 'error'");
    expect(source).toContain("searchParams.get('reason')");
    expect(source).toContain('setupErrorMessage(failureReason)');
    expect(source).toContain("setState('error')");
  });

  test('the error state offers Back to where the flow started, not only the app root', () => {
    expect(source).toContain('href={backHref} replace prefetch onClick={clearGitHubSetupReturn}');
  });

  test('never prints the raw reason slug — every branch is a sentence', () => {
    // `setupErrorMessage` is a total function over the slug, defaulting to a
    // sentence. A `reason` rendered directly would put `owner_unresolved` on
    // screen.
    expect(source).toContain('function setupErrorMessage(reason: string | null): string');
    expect(source).toContain('default:');
    expect(source).not.toContain('{failureReason}');
  });

  test('the already-linked dead end offers the install that resolves it', () => {
    expect(source).toContain(
      'To connect another organization, install the Kortix App on it.',
    );
    // Only when the instance HAS an App to install; otherwise it says so
    // instead of offering a button that cannot work.
    expect(source).toContain('result.install_url');
    expect(source).toContain('This instance has no GitHub App to install.');
  });

  test('warns on a row whose installation already backs other Kortix accounts', () => {
    expect(source).toContain('installation.linked_to_other_accounts > 0');
    expect(source).toContain('text0b0e4c425624');
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
    // The token comes back as `#github_token=`. NOT `#access_token=`: that is
    // the fragment the app's auth client reads as an implicit-flow session on
    // every load; a GitHub token under it failed validation and cleared the
    // opener's session mid-link ("verify with GitHub logs me out", dev,
    // 2026-09-17). Pinned on both sides — the API writes the same key.
    expect(popupSource).toContain("hashParams.get('github_token')");
    expect(popupSource).not.toContain("get('access_token')");
    const apiSource = readFileSync(
      new URL('../../../../../../api/src/platform/routes/github-app.ts', import.meta.url),
      'utf8',
    );
    expect(apiSource).toContain('new URLSearchParams({ github_token: accessToken })');
  });
});
