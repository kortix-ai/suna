import { describe, expect, test } from 'bun:test';
// eslint-disable-next-line no-restricted-imports -- the test parses the debug samples with the real parser
import { createGenuiParser } from '@kortix/sdk/genui';

import { BROKEN_TABS as SDK_BROKEN_TABS } from '../../../../../../../../packages/sdk/src/genui/test-fixtures';
import { BROKEN_TABS, CHILD_ONLY, GENUI_SAMPLES, genuiCatalog, PLAYGROUND_SOURCE } from './samples';

const parse = (source: string) => createGenuiParser().update(source, false);

describe('/debug/genui samples', () => {
  // A loop, not test.each: @types/bun does not type test.each (a known web tsc gap).
  for (const sample of GENUI_SAMPLES.filter((s) => !s.invalid)) {
    test(`${sample.title ?? sample.component} parses with zero issues and a root`, () => {
      const result = parse(sample.source);
      expect(result.issues).toEqual([]);
      expect(result.root).not.toBeNull();
    });
  }

  test('the playground source parses with zero issues and a root', () => {
    const result = parse(PLAYGROUND_SOURCE);
    expect(result.issues).toEqual([]);
    expect(result.root).not.toBeNull();
  });

  test('the invalid sample is the SDK fixture and reports issues', () => {
    expect(BROKEN_TABS).toBe(SDK_BROKEN_TABS);
    expect(parse(BROKEN_TABS).issues.length).toBeGreaterThan(0);
  });

  test('one section per top-level catalog component, in catalog order; every component appears in a sample', () => {
    const catalog = genuiCatalog().map((entry) => entry.name);
    expect(catalog.length).toBeGreaterThan(20);
    const primary = GENUI_SAMPLES.filter((s) => !s.title).map((s) => s.component);
    expect(primary).toEqual(catalog.filter((name) => !(name in CHILD_ONLY)));
    for (const name of catalog) {
      expect(GENUI_SAMPLES.some((s) => !s.invalid && s.source.includes(`${name}(`))).toBe(true);
    }
    for (const [child, parent] of Object.entries(CHILD_ONLY)) {
      expect(catalog).toContain(child);
      expect(
        GENUI_SAMPLES.some((s) => s.component === parent && s.source.includes(`${child}(`)),
      ).toBe(true);
    }
  });

  test('the 10-item RankedList has 10 items', () => {
    const sample = GENUI_SAMPLES.find((s) => s.title === 'RankedList, 10 items')!;
    const list = (
      parse(sample.source).root!.props.children as { props: { items: unknown[] } }[]
    )[0]!;
    expect(list.props.items).toHaveLength(10);
  });
});
