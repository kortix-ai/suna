import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectPageHeader } from './project-page-header';

// Apps, Reminders, Review and Files lost their only page heading when they
// moved onto this header (#8761): the title became a tab, and a tab's children
// are presentational, so nothing on the page was a heading any more. The e2e
// journeys 18-apps-ui and 36-reminders-ui find these pages by that heading.
test('the standalone page header gives the page exactly one h1, named by its title', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectPageHeader, { title: 'Apps', href: '/projects/p/apps' }),
  );
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toContain('<h1 class="sr-only">Apps</h1>');
  // The visible title is still the tab link.
  expect(html).toContain('href="/projects/p/apps"');
});
