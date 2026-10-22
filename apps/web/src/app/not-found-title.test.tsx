/**
 * The 404 boundary owns its document title (KRTX-1767).
 *
 * A client-side navigation into the not-found boundary can mount no flight
 * head — the not-found render replaces a layout that itself aborted (the
 * footer Blog link → /blog) — so document.title kept the previous page's
 * title while a hard load showed the 404 title. The boundary renders
 * NotFoundTitleSync, which writes the composed 404 title and keeps it in
 * place for as long as the boundary is mounted.
 *
 * This drives the boundary itself through react-dom/client on happy-dom (the
 * confetti.test.tsx pattern), so the assertion covers the mounted boundary —
 * not only the sync component in isolation. `next/link` is mocked (the
 * site-link.test.tsx mock) because the rendered anchors never navigate. The
 * module namespace is kept and `default` is read inside each test: under
 * bun's mock registry the namespace property is a live binding that is still
 * uninitialized while the file body destructures it.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.MutationObserver = win.MutationObserver;

mock.module('next/link', () => ({
  default: function MockNextLink({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href?: string;
  }) {
    return <a href={href}>{children}</a>;
  },
}));

const notFoundModule = await import('@/app/[locale]/not-found');

/** The composed title the boundary's metadata and sync produce. */
const NOT_FOUND_TITLE = '404 Page not found | Kortix';

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
});

async function renderNotFound(): Promise<string> {
  const NotFound = notFoundModule.default;
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(<NotFound />);
  });
  return host.querySelector('h1')?.textContent ?? '';
}

test('a rendered 404 boundary sets the document title the 404 metadata produces', async () => {
  document.title = 'Sentinel';

  const heading = await renderNotFound();

  expect(heading).toContain('404');
  expect(document.title).toBe(NOT_FOUND_TITLE);
});

test('the title sync stays quiet when the title already shows the 404 heading', async () => {
  document.title = NOT_FOUND_TITLE;

  await renderNotFound();

  expect(document.title).toBe(NOT_FOUND_TITLE);
});
