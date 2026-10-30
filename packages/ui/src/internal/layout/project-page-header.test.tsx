import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectPageHeader } from './project-page-header';

// The e2e journey 18-apps-ui finds the page by the h1.
test('the standalone page header gives the page exactly one visible h1, named by its title', () => {
  const html = renderToStaticMarkup(createElement(ProjectPageHeader, { title: 'Apps' }));
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toMatch(/<h1 class="(?![^"]*sr-only)[^"]*">Apps<\/h1>/);
  // A page has one view: no one-tab underline bar.
  expect(html).not.toContain('role="tab"');
});
