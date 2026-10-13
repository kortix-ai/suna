import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import en from '../../../../../translations/en.json';

const SOURCE = readFileSync(resolve(import.meta.dir, 'project-chrome-nav.tsx'), 'utf8');

describe('Kortix in Chrome sidebar row', () => {
  test('is named Kortix in Chrome', () => {
    expect(en.chrome.promoLabel).toBe('Kortix in Chrome');
    expect(SOURCE).toContain("t('promoLabel')");
  });
  test('carries no badge: blue is agent state only, and a promo row needs no "New"', () => {
    expect(SOURCE).not.toContain('SidebarMenuBadge');
    expect(SOURCE).not.toContain('kortix-blue');
  });
});
