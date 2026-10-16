import { describe, expect, test } from 'bun:test';

import { generateMetadata } from './not-found';

describe('the 404 page sets the document title', () => {
  test('the not-found boundary provides the localized 404 heading as its title', async () => {
    const metadata = await generateMetadata();
    // A plain string, so the root layout's `title.template` composes the full
    // document title exactly as it does for every other page.
    expect(metadata.title).toBe('404 Page not found');
  });
});
