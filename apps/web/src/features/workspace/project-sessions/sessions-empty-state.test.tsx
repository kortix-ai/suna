import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PIXEL_KORTIX_ROWS, PixelKortixMark } from '@/components/ui/pixel-kortix-mark';

import { SessionsEmptyState } from './sessions-empty-state';

const filledCells = PIXEL_KORTIX_ROWS.join('').replace(/ /g, '').length;
const ditheredCells = PIXEL_KORTIX_ROWS.join('').replace(/[^+]/g, '').length;

describe('PixelKortixMark', () => {
  const html = renderToStaticMarkup(createElement(PixelKortixMark));

  test('draws one square per filled cell', () => {
    // One rect per cell, plus the two squares of the checker pattern.
    expect(html.match(/<rect/g)?.length).toBe(filledCells + 2);
  });

  test('dithers exactly the partly covered cells through its own pattern', () => {
    const id = html.match(/<pattern id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html.split(`fill="url(#${id})"`).length - 1).toBe(ditheredCells);
  });

  test('is hidden from assistive technology', () => {
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('SessionsEmptyState', () => {
  test('says where sessions will appear, above the pixel mark', () => {
    const html = renderToStaticMarkup(createElement(SessionsEmptyState));

    const text = html.indexOf('Sessions you start will show up here');
    expect(text).toBeGreaterThan(-1);
    expect(html.indexOf('<svg')).toBeGreaterThan(text);
  });

  test('offers no button — both lists already have a New session control', () => {
    const html = renderToStaticMarkup(createElement(SessionsEmptyState));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
});

describe('both empty session lists use it', () => {
  const sidebar = readFileSync(
    join(import.meta.dir, '..', 'project-sidebar', 'project-session-list.tsx'),
    'utf8',
  );
  const page = readFileSync(join(import.meta.dir, 'project-sessions-view.tsx'), 'utf8');

  test('the sessions page', () => {
    expect(page).toContain('<SessionsEmptyState');
  });

  // The sidebar's empty list is the first chat's row while that chat waits,
  // and the pixel empty state otherwise.
  test('the sidebar, after the first chat', () => {
    const empty = sidebar.slice(
      sidebar.indexOf("if (viewState === 'empty')"),
      sidebar.indexOf("if (viewState === 'no-matches')"),
    );
    expect(empty).toContain('firstChatPending ?');
    expect(empty).toContain('<FirstChatRow');
    expect(empty).toContain('<SessionsEmptyState');
  });

  // The first chat never leaves: once sessions exist it sits at the bottom,
  // after the last page.
  test('the sidebar, with sessions', () => {
    const list = sidebar.slice(sidebar.indexOf('<FadedScrollArea fadeColor="from-background"'));
    expect(list.indexOf('{firstChatPending && !hasNextPage && (')).toBeGreaterThan(
      list.indexOf('grouped.sections.map('),
    );
  });
});
