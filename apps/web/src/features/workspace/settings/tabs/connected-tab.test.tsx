import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectedAccountsTabView } from './connected-tab';

/** The pane heading. Rows are NOT headings — see `rowLabels`. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

/**
 * The provider row labels, in document order.
 *
 * These assertions used to go through `headings()`, from when each provider
 * was its own `<h3>` section. The rows are `SettingsRow`s now, so a label is
 * a `FieldTitle` — `<div data-slot="field-label">` (`ui/field.tsx:125`) — and
 * `headings()` matches only the pane's own `<h2>`. Reading the label slot is
 * the same assertion against the shape the component actually renders.
 */
const rowLabels = (html: string): string[] =>
  [...html.matchAll(/<div[^>]*data-slot="field-label"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);

/** `Skeleton` (`ui/skeleton.tsx`) carries no data-slot; `animate-pulse` is its
 *  stable marker and nothing else in this view animates. */
const skeletons = (html: string): number => [...html.matchAll(/animate-pulse/g)].length;

describe('ConnectedAccountsTabView', () => {
  test('renders one row per provider, in order', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(headings(out)).toEqual(['Connected accounts']);
    expect(rowLabels(out)).toEqual(['GitHub', 'ChatGPT']);
  });

  test('every row states which scope it writes to', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(out).toMatch(/for this account/i);
    expect(out).toMatch(/for this workspace/i);
  });

  test('the GitHub row is absent without account.write', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount={false} />);
    expect(rowLabels(out)).toEqual(['ChatGPT']);
  });

  test('each row carries exactly one action button', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect([...out.matchAll(/<button/g)]).toHaveLength(2);
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
    expect(rowLabels(out)).toContain('GitHub');
  });

  // Jay, 2026-08-12 — the loading state belongs to the row's action slot.
  // It used to be a full-width `h-14` `Skeleton` rendered BELOW the row while
  // the action slot rendered `null`: the row looked finished (label,
  // description, no control) with an unexplained grey block under it, and the
  // block's disappearance changed the section's height. These three tests pin
  // the replacement so it cannot regress to a sibling block again.
  describe('a provider whose status has not resolved', () => {
    test('puts a skeleton in the action slot and renders no button for that row', () => {
      const out = renderToStaticMarkup(
        <ConnectedAccountsTabView canManageAccount githubStatus="loading" />,
      );
      // One skeleton (GitHub's action slot), one button (ChatGPT's, resolved).
      expect(skeletons(out)).toBe(1);
      expect([...out.matchAll(/<button/g)]).toHaveLength(1);
    });

    test('shape-matches the button it replaces, so the row height never changes', () => {
      const out = renderToStaticMarkup(
        <ConnectedAccountsTabView canManageAccount githubStatus="loading" />,
      );
      // `Button size="sm"` is `h-8` and the base class is `rounded-md`
      // (`ui/button.tsx:8,60`) — the skeleton claims exactly that box.
      expect(out).toMatch(/animate-pulse[^"]*"|"[^"]*h-8[^"]*rounded-md/);
      expect(out).toContain('h-8 w-24 rounded-md');
    });

    test('does not assert a connection state it cannot know yet', () => {
      const out = renderToStaticMarkup(
        <ConnectedAccountsTabView canManageAccount githubStatus="loading" chatgptStatus="loading" />,
      );
      expect(out).not.toMatch(/Install the GitHub App/);
      expect(out).not.toMatch(/Sign in with a ChatGPT Plus/);
      expect(out).toMatch(/Checking this account/);
      expect(out).toMatch(/Checking this workspace/);
    });
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
    expect([...out.matchAll(/<button/g)]).toHaveLength(2);
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
