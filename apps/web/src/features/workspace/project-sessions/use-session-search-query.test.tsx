import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useSessionSearchQuery } from './use-session-search-query';

/** The `q` the hook yields on its first render, which is the value the
 *  sessions page and the command palette send as `useProjectSessions({ q })`. */
function searchQueryFor(text: string): string {
  let q = '';
  function Probe() {
    q = useSessionSearchQuery(text);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return q;
}

test('a 300-character search sends a 200-character q, never a request the API rejects', () => {
  const typed = 'a'.repeat(300);
  const q = searchQueryFor(typed);
  expect(q).toHaveLength(200);
  expect(q).toBe(typed.slice(0, 200));
});

test('the q is trimmed, and blank text sends no search', () => {
  expect(searchQueryFor('  deploy notes  ')).toBe('deploy notes');
  expect(searchQueryFor('   ')).toBe('');
});
