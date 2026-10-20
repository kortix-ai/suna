import { describe, expect, test } from 'bun:test';

import { generateMetadata } from './not-found';

describe('the global 404 page sets the document title', () => {
  test('the root not-found page composes the localized 404 heading with the brand suffix', async () => {
    const metadata = await generateMetadata();
    // No root layout sits above this page, so it composes the full document
    // title itself — the [locale] layout's `title.template` never sees it.
    expect(metadata.title).toBe('404 Page not found | Kortix');
  });
});
