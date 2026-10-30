import { describe, expect, test } from 'bun:test';

import * as catchAll from './page';
import { generateMetadata } from './page';

describe('the catch-all 404 route sets the document title', () => {
  test('the catch-all provides the localized 404 heading as its title', async () => {
    const metadata = await generateMetadata();
    // A plain string, so the [locale] layout's `title.template` composes the
    // full document title exactly as it does for every other page — this is
    // the route a client-side navigation to a locale-prefixed missing path
    // lands on, and the App Router applies this metadata to the tab title.
    expect(metadata.title).toBe('404 Page not found');
  });
});

// KRTX-3253: this route renders its own metadata before notFound(), so its
// head carried the root layout's `index, follow` beside the `noindex` that
// notFound() adds.
test('the catch-all 404 is not indexed', async () => {
  const metadata = await generateMetadata();
  expect(metadata.robots).toEqual({ index: false, follow: true });
});

// KRTX-3169: notFound() in this page threw inside the I18nProvider Suspense
// boundary, after the shell had flushed, so every unmatched path answered 200.
// No path renders this page: the router answers 404 before any render.
test('the router answers an unmatched path with 404 before rendering', async () => {
  expect(catchAll.dynamicParams).toBe(false);
  expect(await catchAll.generateStaticParams()).toEqual([]);
});
