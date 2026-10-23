import { expect, test } from 'bun:test';

import * as homeLayout from './layout';

// KRTX-3255. The home route is `/[locale]`, the one route a one-segment path
// such as `/security.txt` reaches. Its locales are prerendered; an unknown one
// was rendered on demand and failed with "Page changed from static to dynamic
// at runtime" (500 on kortix.com). It must be a 404 without a render.
test('the home route renders only the prerendered locales', () => {
  expect(homeLayout.dynamicParams).toBe(false);
});
