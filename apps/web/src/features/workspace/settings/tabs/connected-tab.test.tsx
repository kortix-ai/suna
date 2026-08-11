import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectedAccountsTabView } from './connected-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

describe('ConnectedAccountsTabView', () => {
  test('renders one row per provider, in order', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(headings(out)).toEqual(['Connected accounts', 'GitHub', 'ChatGPT', 'Claude Code']);
  });

  test('every row states which scope it writes to', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(out).toMatch(/for this account/i);
    expect(out).toMatch(/for this workspace/i);
  });

  test('the GitHub row is absent without account.write', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount={false} />);
    expect(headings(out)).toEqual(['Connected accounts', 'ChatGPT', 'Claude Code']);
  });

  test('each row carries exactly one action button', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect([...out.matchAll(/<button/g)]).toHaveLength(3);
  });

  // Fix round 1, finding 1 — proof that the GitHub row renders purely off
  // `canManageAccount`, independent of how that boolean was resolved (no
  // project, a project, or any other source). Composed with
  // `resolveConnectedAccountsId`'s tests below: together they prove the
  // reviewer's "no project, user has account.write, GitHub row renders"
  // scenario end to end — resolution produces a real account id with no
  // project open, and any real id feeding `canManageAccount: true` renders
  // the row. The container itself can't be mounted here (no
  // QueryClientProvider/router/auth session in `bun test` — see this file's
  // header comment), so this is the strongest proof available without a DOM
  // or a live network.
  test('the GitHub row renders whenever canManageAccount is true, with no dependency on a project prop existing at all', () => {
    const out = renderToStaticMarkup(
      <ConnectedAccountsTabView canManageAccount githubStatus="connected" />,
    );
    expect(headings(out)).toContain('GitHub');
  });

  // Fix round 1, finding 2 — a second installation gets a link, not a second
  // button, so "each row carries exactly one action button" still holds even
  // when `installations.length > 1`.
  test('multiple GitHub installations add a link, not a second button', () => {
    const out = renderToStaticMarkup(
      <ConnectedAccountsTabView
        canManageAccount
        githubStatus="connected"
        githubInstallationName="github.com/acme"
        githubOtherInstallationsCount={2}
        githubManageAllHref="/accounts/acc_1?tab=git"
      />,
    );
    expect([...out.matchAll(/<button/g)]).toHaveLength(3);
    expect(out).toContain('href="/accounts/acc_1?tab=git"');
    expect(out).toMatch(/\+2 more installations/);
  });

  test('a single GitHub installation shows no "manage all" link', () => {
    const out = renderToStaticMarkup(
      <ConnectedAccountsTabView
        canManageAccount
        githubStatus="connected"
        githubInstallationName="github.com/acme"
        githubOtherInstallationsCount={0}
        githubManageAllHref="/accounts/acc_1?tab=git"
      />,
    );
    expect(out).not.toContain('manage all');
  });

  // Task 545 — `GitHubAppSetupCard` (the self-host GitHub App setup card)
  // rehomed here so it survives the accounts-page deletion ticket. It's
  // passed as a slot rather than imported directly (see this file's header
  // comment): the real card needs a `QueryClientProvider`, which
  // `renderToStaticMarkup` doesn't provide, so these tests stand a marker
  // `<div>` in for it — same pattern `api-keys-tab.test.tsx` uses for its
  // slots.
  test('the GitHub App setup slot renders immediately after the GitHub section — matches page.tsx:579-583', () => {
    const out = renderToStaticMarkup(
      <ConnectedAccountsTabView
        canManageAccount
        githubStatus="connected"
        githubInstallationName="github.com/acme"
        githubAppSetupSlot={<div>github-app-setup-marker</div>}
      />,
    );
    expect(out).toContain('github-app-setup-marker');
    expect(out.indexOf('GitHub')).toBeLessThan(out.indexOf('github-app-setup-marker'));
    expect(out.indexOf('github-app-setup-marker')).toBeLessThan(out.indexOf('ChatGPT'));
  });

  test('the GitHub App setup slot is absent without account.write, same as the GitHub row it pairs with', () => {
    const out = renderToStaticMarkup(
      <ConnectedAccountsTabView
        canManageAccount={false}
        githubAppSetupSlot={<div>github-app-setup-marker</div>}
      />,
    );
    expect(out).not.toContain('github-app-setup-marker');
  });
});

// The `resolveConnectedAccountsId` resolver tests that used to live here
// moved to `resolveSettingsAccountId` in `../use-settings-account-id.test.tsx`
// (Task 11) — the resolver itself moved to `../use-settings-account-id.ts`
// before Phase 3's six new account-scoped tabs each needed the identical
// fallback. See that file's header comment.
