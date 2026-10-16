import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectPageHeader, type ProjectPageHeaderTab } from './project-page-header';

// The e2e journeys 18-apps-ui and 36-reminders-ui find these pages by the h1.
test('the standalone page header gives the page exactly one visible h1, named by its title', () => {
  const html = renderToStaticMarkup(createElement(ProjectPageHeader, { title: 'Apps' }));
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toMatch(/<h1 class="(?![^"]*sr-only)[^"]*">Apps<\/h1>/);
  // A page has one view: no one-tab underline bar.
  expect(html).not.toContain('role="tab"');
});

const REPO_TABS: ProjectPageHeaderTab[] = [
  { key: 'repo', label: 'Repo', href: '/projects/p1/files', active: true },
  { key: 'review', label: 'Review', href: '/projects/p1/files/review', active: false },
];

// The merged Repo page (KRTX-2444): two views in one surface, so the title is
// an underline tab bar in the CapabilityTabs style.
test('a multi-view page header renders its tabs instead of a plain h1', () => {
  const html = renderToStaticMarkup(createElement(ProjectPageHeader, { title: 'Repo', tabs: REPO_TABS }));
  expect(html).not.toMatch(/<h1\b/);
  const tabTriggers = html.match(/role="tab"/g) ?? [];
  expect(tabTriggers.length).toBe(2);
  expect(html).toContain('href="/projects/p1/files"');
  expect(html).toContain('href="/projects/p1/files/review"');
  // Exactly one trigger is marked current.
  expect((html.match(/data-state="active"/g) ?? []).length).toBe(1);
});

test('a single view keeps the plain h1, even when it is passed as a one-entry tab list', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectPageHeader, {
      title: 'Review',
      tabs: [REPO_TABS[1]!],
    }),
  );
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toMatch(/<h1 class="(?![^"]*sr-only)[^"]*">Review<\/h1>/);
  expect(html).not.toContain('role="tab"');
});
