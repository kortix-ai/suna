import { describe, expect, test } from 'bun:test';

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
