import { describe, expect, test } from 'bun:test';
import { CATEGORY_ROW_CAP, groupByCategory, humanizeCategory } from './connector-categories';

const item = (name: string, categories: string[]) => ({ name, categories });

describe('groupByCategory', () => {
  const get = (i: { categories: string[] }) => i.categories;

  test('an item appears under each of its categories', () => {
    const groups = groupByCategory([item('a', ['Developer', 'Data'])], get);
    expect(groups.map((g) => g.category).sort()).toEqual(['Data', 'Developer']);
  });

  test('groups sort by size, then alphabetically', () => {
    const groups = groupByCategory(
      [item('a', ['Developer']), item('b', ['Developer']), item('c', ['Analytics'])],
      get,
    );
    expect(groups.map((g) => g.category)).toEqual(['Developer', 'Analytics']);
  });

  test('an uncategorized item lands in Other', () => {
    const groups = groupByCategory([item('a', [])], get);
    expect(groups).toEqual([{ category: 'Other', items: [item('a', [])] }]);
  });

  test('Other sorts last even when it is the biggest group', () => {
    const groups = groupByCategory([item('a', []), item('b', []), item('c', ['Developer'])], get);
    expect(groups[groups.length - 1]?.category).toBe('Other');
  });

  // The live catalogue really does ship this: `Malwarebytes` comes back with
  // `categories: ['']`. A length check alone would accept the empty string as
  // a category and render a section under a blank heading.
  test('a single empty-string category is not a category — the item lands in Other', () => {
    const groups = groupByCategory([item('malwarebytes', [''])], get);
    expect(groups).toEqual([{ category: 'Other', items: [item('malwarebytes', [''])] }]);
  });

  test('a whitespace-only category is not a category either', () => {
    const groups = groupByCategory([item('a', ['   '])], get);
    expect(groups.map((g) => g.category)).toEqual(['Other']);
  });

  test('blank entries are dropped without dragging the whole item into Other', () => {
    const groups = groupByCategory([item('a', ['', 'data'])], get);
    expect(groups.map((g) => g.category)).toEqual(['data']);
  });

  test('surrounding whitespace never forks one category into two groups', () => {
    const groups = groupByCategory([item('a', [' data']), item('b', ['data '])], get);
    expect(groups).toEqual([
      { category: 'data', items: [item('a', [' data']), item('b', ['data '])] },
    ]);
  });

  test('a category repeated on one item does not duplicate the card', () => {
    const groups = groupByCategory([item('a', ['data', 'data'])], get);
    expect(groups).toEqual([{ category: 'data', items: [item('a', ['data', 'data'])] }]);
  });

  test('the row cap is two rows of the widest grid', () => {
    expect(CATEGORY_ROW_CAP).toBe(6);
  });
});

describe('humanizeCategory', () => {
  test('a kebab-case catalogue value reads as one sentence-case phrase', () => {
    expect(humanizeCategory('sales-and-marketing')).toBe('Sales and marketing');
    expect(humanizeCategory('financial-services')).toBe('Financial services');
    expect(humanizeCategory('life-sciences')).toBe('Life sciences');
  });

  test('a single-word value is only capitalized', () => {
    expect(humanizeCategory('productivity')).toBe('Productivity');
    expect(humanizeCategory('code')).toBe('Code');
  });

  test('an already-capitalized value is left alone', () => {
    expect(humanizeCategory('Other')).toBe('Other');
  });

  // Only the FIRST character is touched. Lowercasing the tail would turn a
  // real acronym into `Crm`, which is worse than leaving it as the catalogue
  // published it.
  test('an acronym keeps its own casing', () => {
    expect(humanizeCategory('CRM')).toBe('CRM');
  });

  test('surrounding whitespace is trimmed', () => {
    expect(humanizeCategory('  data  ')).toBe('Data');
  });
});
