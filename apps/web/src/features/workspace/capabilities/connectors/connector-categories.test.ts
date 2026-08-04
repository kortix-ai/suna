import { describe, expect, test } from 'bun:test';
import {
  CATEGORY_ROW_CAP,
  CURATED_SECTIONS,
  groupIntoSections,
  humanizeCategory,
  sectionKeyForCategory,
  sectionTitle,
} from './connector-categories';

const item = (name: string, categories: string[]) => ({ name, categories });
const get = (i: { categories: string[] }) => i.categories;
const keys = (groups: Array<{ category: string }>) => groups.map((g) => g.category);

describe('CURATED_SECTIONS', () => {
  test('leads with Productivity and buries Developer tools last', () => {
    // The whole point of the list. Someone browsing sees work-getting-done
    // tools first; someone who wants GitHub searches for GitHub.
    expect(CURATED_SECTIONS[0]?.key).toBe('productivity');
    expect(CURATED_SECTIONS[CURATED_SECTIONS.length - 1]?.key).toBe('developer-tools');
  });

  test('the requested order is exactly the first six', () => {
    expect(CURATED_SECTIONS.slice(0, 6).map((s) => s.key)).toEqual([
      'productivity',
      'operations',
      'finance',
      'data-analytics',
      'communication',
      'sales-marketing',
    ]);
  });

  test('no key can collide with the ALL_CATEGORIES sentinel', () => {
    // `ALL_CATEGORIES` is `' all'`, and `sectionKeyForCategory` trims, so a key
    // that led with a space would be both unreachable and ambiguous.
    for (const section of CURATED_SECTIONS) {
      expect(section.key).toBe(section.key.trim());
      expect(section.key).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  test('no raw category is claimed by two sections', () => {
    // A duplicated token would silently resolve to whichever section was
    // declared last, so the section a card lands in would depend on list
    // order rather than on anything anyone decided.
    const seen = new Map<string, string>();
    for (const section of CURATED_SECTIONS) {
      for (const token of section.match) {
        expect(seen.get(token) ?? section.key).toBe(section.key);
        seen.set(token, section.key);
      }
    }
  });

  test('every match token is already folded', () => {
    // Lookups fold the raw value before comparing, so an unfolded token like
    // `data-analytics` could never match anything.
    for (const section of CURATED_SECTIONS) {
      for (const token of section.match) expect(token).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('sectionKeyForCategory', () => {
  test('folds every spelling of one category into one section', () => {
    for (const raw of ['Data Analytics', 'data-analytics', 'data_analytics', 'DATAANALYTICS']) {
      expect(sectionKeyForCategory(raw)).toBe('data-analytics');
    }
  });

  test('distinct raw categories roll up into one section', () => {
    expect(sectionKeyForCategory('project-management')).toBe('productivity');
    expect(sectionKeyForCategory('task-management')).toBe('productivity');
    expect(sectionKeyForCategory('Sales & CRM')).toBe('sales-marketing');
    expect(sectionKeyForCategory('marketing')).toBe('sales-marketing');
  });

  test('an unclaimed category keeps its own trimmed value', () => {
    expect(sectionKeyForCategory('  business-management  ')).toBe('business-management');
    expect(sectionKeyForCategory('life-sciences')).toBe('life-sciences');
  });
});

describe('sectionTitle', () => {
  test('a curated section uses the title we chose, not the catalogue value', () => {
    expect(sectionTitle('data-analytics')).toBe('Data & analytics');
    expect(sectionTitle('sales-marketing')).toBe('Sales & marketing');
  });

  test('an unclaimed section still reads as a sentence', () => {
    expect(sectionTitle('business-management')).toBe('Business management');
    expect(sectionTitle('Other')).toBe('Other');
  });
});

describe('groupIntoSections', () => {
  test('curated order wins over bucket size', () => {
    // The regression this replaced: three developer apps outranked one
    // productivity app purely by count, and "Business management" led the page
    // because the upstream feed happened to fill it most.
    const groups = groupIntoSections(
      [
        item('a', ['developer-tools']),
        item('b', ['developer-tools']),
        item('c', ['developer-tools']),
        item('d', ['productivity']),
      ],
      get,
    );
    expect(keys(groups)).toEqual(['productivity', 'developer-tools']);
  });

  test('business management is no longer top, even as the biggest bucket', () => {
    const groups = groupIntoSections(
      [
        item('a', ['Business Management']),
        item('b', ['Business Management']),
        item('c', ['Business Management']),
        item('d', ['communication']),
      ],
      get,
    );
    expect(keys(groups)).toEqual(['communication', 'Business Management']);
  });

  test('an uncurated category still renders — below the curated ones', () => {
    const groups = groupIntoSections(
      [item('a', ['life-sciences']), item('b', ['finance'])],
      get,
    );
    expect(keys(groups)).toEqual(['finance', 'life-sciences']);
  });

  test('the uncurated tail is still ordered by size, then alphabetically', () => {
    const groups = groupIntoSections(
      [item('a', ['zeta']), item('b', ['zeta']), item('c', ['alpha'])],
      get,
    );
    expect(keys(groups)).toEqual(['zeta', 'alpha']);
  });

  test('two raw categories folding into one section do not duplicate the card', () => {
    // `project-management` and `task-management` both roll into Productivity.
    // Deduping the RAW names (the old behaviour) would push this item twice
    // into one bucket, under two identical React keys.
    const groups = groupIntoSections(
      [item('a', ['project-management', 'task-management'])],
      get,
    );
    expect(groups).toEqual([
      { category: 'productivity', items: [item('a', ['project-management', 'task-management'])] },
    ]);
  });

  test('an item still appears under each distinct section it claims', () => {
    const groups = groupIntoSections([item('a', ['developer-tools', 'data-analytics'])], get);
    expect(keys(groups).sort()).toEqual(['data-analytics', 'developer-tools']);
  });

  test('an uncategorized item lands in Other', () => {
    const groups = groupIntoSections([item('a', [])], get);
    expect(groups).toEqual([{ category: 'Other', items: [item('a', [])] }]);
  });

  test('Other sorts last even when it is the biggest group', () => {
    const groups = groupIntoSections(
      [item('a', []), item('b', []), item('c', ['life-sciences'])],
      get,
    );
    expect(groups[groups.length - 1]?.category).toBe('Other');
  });

  // The live catalogue really does ship this: `Malwarebytes` comes back with
  // `categories: ['']`. A length check alone would accept the empty string as
  // a category and render a section under a blank heading.
  test('a single empty-string category is not a category — the item lands in Other', () => {
    const groups = groupIntoSections([item('malwarebytes', [''])], get);
    expect(groups).toEqual([{ category: 'Other', items: [item('malwarebytes', [''])] }]);
  });

  test('a whitespace-only category is not a category either', () => {
    const groups = groupIntoSections([item('a', ['   '])], get);
    expect(keys(groups)).toEqual(['Other']);
  });

  test('blank entries are dropped without dragging the whole item into Other', () => {
    const groups = groupIntoSections([item('a', ['', 'data'])], get);
    expect(keys(groups)).toEqual(['data-analytics']);
  });

  test('surrounding whitespace never forks one category into two groups', () => {
    const groups = groupIntoSections([item('a', [' data']), item('b', ['data '])], get);
    expect(groups).toEqual([
      { category: 'data-analytics', items: [item('a', [' data']), item('b', ['data '])] },
    ]);
  });

  test('a category repeated on one item does not duplicate the card', () => {
    const groups = groupIntoSections([item('a', ['data', 'data'])], get);
    expect(groups).toEqual([
      { category: 'data-analytics', items: [item('a', ['data', 'data'])] },
    ]);
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
