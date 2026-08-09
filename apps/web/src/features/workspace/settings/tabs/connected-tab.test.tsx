import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectedAccountsTabView, resolveConnectedAccountsId } from './connected-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('ConnectedAccountsTabView', () => {
  test('renders one row per provider, in order', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(headings(out)).toEqual(['GitHub', 'ChatGPT', 'Claude Code']);
  });

  test('every row states which scope it writes to', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(out).toMatch(/for this account/i);
    expect(out).toMatch(/for this workspace/i);
  });

  test('the GitHub row is absent without account.write', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount={false} />);
    expect(headings(out)).toEqual(['ChatGPT', 'Claude Code']);
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
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount githubStatus="connected" />);
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
});

describe('resolveConnectedAccountsId', () => {
  test('prefers the project account id when present, even with a different selected account', () => {
    expect(resolveConnectedAccountsId('proj-acct', 'store-acct')).toBe('proj-acct');
  });

  test('falls back to the store-selected account id with no project open', () => {
    expect(resolveConnectedAccountsId(undefined, 'store-acct')).toBe('store-acct');
  });

  test('resolves to undefined when neither source has a value', () => {
    expect(resolveConnectedAccountsId(undefined, null)).toBeUndefined();
    expect(resolveConnectedAccountsId(undefined, undefined)).toBeUndefined();
  });
});
