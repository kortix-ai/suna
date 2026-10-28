import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window({ url: 'http://localhost/legal' });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let params = new URLSearchParams();
mock.module('next/navigation', () => ({
  useSearchParams: () => params,
  usePathname: () => '/legal',
}));
// Scrolling is a browser collaborator; keep the page and TOC rendering real.
mock.module('@/hooks/use-active-section', () => ({ useActiveSection: (ids: string[]) => ids[0] }));
const { default: LegalPage } = await import('./page');
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function render(query: string) {
  params = new URLSearchParams(query);
  window.history.replaceState(null, '', `/legal?${query}`);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<LegalPage />));
}

function assertDocument(heading: string, dated: boolean) {
  const article = document.querySelector('article');
  expect(article?.querySelector('h2')?.textContent).toBe(heading);
  expect(article?.textContent?.includes('Last updated')).toBe(dated);
  const links = [...document.querySelectorAll('aside a')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const section = document.getElementById(link.getAttribute('href')?.slice(1) ?? '');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain(link.textContent ?? '');
  }
  expect(article?.textContent?.length).toBeGreaterThan(500);
}

for (const [query, heading, dated] of [
  ['', 'Imprint', false],
  ['tab=invalid', 'Imprint', false],
  ['tab=imprint', 'Imprint', false],
  ['tab=terms', 'Terms of Service', true],
  ['tab=privacy', 'Privacy Policy', true],
] as const) {
  test(`legal document for ${query || 'missing tab'}`, async () => {
    await render(query);
    assertDocument(heading, dated);
  });
}

test('click paints immediately, preserves query parameters, and later URL changes reconcile', async () => {
  await render('tab=imprint&campaign=synthetic');
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Terms of Service');
  expect(button).toBeDefined();
  await act(async () => button?.click());
  assertDocument('Terms of Service', true);
  expect(window.location.search).toBe('?tab=terms&campaign=synthetic');
  params = new URLSearchParams('tab=privacy&campaign=synthetic');
  await act(async () => root?.render(<LegalPage />));
  assertDocument('Privacy Policy', true);
  params = new URLSearchParams('tab=invalid');
  await act(async () => root?.render(<LegalPage />));
  assertDocument('Imprint', false);
});
