import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectPageHeader } from './project-page-header';

// The header's trailing account chip (KRTX-2145) reads the session itself, so
// the static render stands in a stub provider — the same pattern
// `account-menu-button.test.tsx` uses.
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { email: 'dev@example.test', user_metadata: { name: 'Grace Hopper' } },
    session: null,
    isLoading: false,
  }),
}));

// The e2e journeys 18-apps-ui and 36-reminders-ui find these pages by the h1.
test('the standalone page header gives the page exactly one visible h1, named by its title', () => {
  const html = renderToStaticMarkup(createElement(ProjectPageHeader, { title: 'Apps' }));
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toMatch(/<h1 class="(?![^"]*sr-only)[^"]*">Apps<\/h1>/);
  // A page has one view: no one-tab underline bar.
  expect(html).not.toContain('role="tab"');
});

/**
 * KRTX-2145 regression: the account control renders on a non-`/new`
 * authenticated page. Review, Files, Reminders and Apps share this header, so
 * the chip must be part of it — identity, profile settings and log out are
 * reachable from every capability page, and the embedded marker tells the
 * project shell's floating corner to stand down here.
 */
test('the header trails with the account chip, stamped as the view that owns it', () => {
  const html = renderToStaticMarkup(createElement(ProjectPageHeader, { title: 'Files' }));
  expect(html).toContain('Logged in as');
  expect(html).toContain('aria-label="Logged in as Grace Hopper"');
  expect(html).toContain('data-kx-account-owner=""');
  // The chip sits after the page actions at the trailing edge, not before the title.
  expect(html.indexOf('data-kx-account-owner')).toBeGreaterThan(html.indexOf('<h1'));
});
