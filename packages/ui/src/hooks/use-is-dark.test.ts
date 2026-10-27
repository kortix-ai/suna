import { afterEach, describe, expect, test } from 'bun:test';

import { isDarkDocument } from './use-is-dark';

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, window: g.window };
afterEach(() => Object.assign(g, saved));

function page(classes: string[], osDark: boolean) {
  g.document = { documentElement: { classList: { contains: (c: string) => classes.includes(c) } } };
  g.window = { matchMedia: () => ({ matches: osDark }) };
}

describe('isDarkDocument follows the .dark class, like the token CSS', () => {
  test('no class + OS dark is light (a host that toggles only `dark`)', () => {
    page([], true);
    expect(isDarkDocument()).toBe(false);
  });
  test('`dark` class is dark', () => {
    page(['dark'], false);
    expect(isDarkDocument()).toBe(true);
  });
});
