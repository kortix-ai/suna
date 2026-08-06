import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_CATEGORIES,
  catalogCategoryKeys,
  resolveActiveCategory,
} from './connector-categories';

const item = (categories: string[]) => ({ categories });

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const page = code(readFileSync(join(import.meta.dir, '..', 'connectors-page.tsx'), 'utf8'));
const browse = code(readFileSync(join(import.meta.dir, 'connector-browse.tsx'), 'utf8'));

/**
 * The category filter's state rules.
 *
 * These exist because of a real bug: the picked category was page state with
 * exactly ONE writer (the dropdown) and no invalidation. It outlived every
 * context that gave it meaning — a tab switch, a search, and the entry set it
 * names — and because Discovery collapses to a flat grid whenever a category
 * is picked, the visible result was "Discovery and All both show one card"
 * with nothing on screen explaining why.
 */
describe('resolveActiveCategory', () => {
  const available = ['productivity', 'finance', 'commerce'];

  test('an unfiltered browse stays unfiltered', () => {
    expect(resolveActiveCategory(ALL_CATEGORIES, available, { searching: false })).toBe(
      ALL_CATEGORIES,
    );
  });

  test('a category that is present is applied', () => {
    expect(resolveActiveCategory('finance', available, { searching: false })).toBe('finance');
  });

  // A text search runs server-side across every category, so re-filtering its
  // results by a category picked beforehand would hide most of what the user
  // asked for.
  test('a search overrides any category', () => {
    expect(resolveActiveCategory('finance', available, { searching: true })).toBe(ALL_CATEGORIES);
  });

  /**
   * The silent one. `catalog.entries` changes under the filter — a refetch, or
   * `useCatalog` flipping source from Easy Connect to Discover once
   * `projectQuery` lands, which swaps the entire category vocabulary. The
   * dropdown then has no option matching the stored value, so Radix renders
   * its placeholder ("All categories") while the grid still filtered by it —
   * `groupIntoSections(...).find(...)` missed, `?? []` swallowed it, and the
   * page showed an empty catalogue it claimed was unfiltered.
   */
  test('a category absent from the current entries degrades to unfiltered', () => {
    expect(resolveActiveCategory('life-sciences', available, { searching: false })).toBe(
      ALL_CATEGORIES,
    );
  });

  test('an empty catalogue cannot leave a filter applied', () => {
    expect(resolveActiveCategory('finance', [], { searching: false })).toBe(ALL_CATEGORIES);
  });
});

/**
 * One derivation, two consumers. The dropdown's options and the grid's filter
 * used to be two independent `groupIntoSections` calls over the same entries,
 * which is what let them disagree about which categories exist.
 */
describe('catalogCategoryKeys', () => {
  test('returns the section keys the grid can actually show', () => {
    const keys = catalogCategoryKeys(
      [item(['productivity']), item(['Sales & CRM']), item(['productivity'])],
      (entry) => entry.categories,
    );
    expect(keys).toEqual(['productivity', 'sales-marketing']);
  });

  test('never offers Popular — it is synthesised, not a queryable bucket', () => {
    // Picking it would filter the grid to a bucket the API cannot be asked
    // for, which is the same dead-filter failure by another route.
    const keys = catalogCategoryKeys([item(['popular']), item(['finance'])], (e) => e.categories);
    expect(keys).not.toContain('popular');
    expect(keys).toContain('finance');
  });

  test('is exactly the set resolveActiveCategory validates against', () => {
    const entries = [item(['productivity']), item(['finance'])];
    const keys = catalogCategoryKeys(entries, (e) => e.categories);
    for (const key of keys) {
      expect(resolveActiveCategory(key, keys, { searching: false })).toBe(key);
    }
  });
});

/**
 * The rules above are inert unless the components actually read them, and both
 * regressions are one plausible-looking edit away: re-deriving the option list
 * inside `CategorySelect`, or taking `category` at face value in the grid.
 */
describe('the page wires the filter to one derivation', () => {
  test('the option list is derived once and handed to both consumers', () => {
    expect(page).toContain('const availableCategories = useMemo(');
    expect(page).toContain('catalogCategoryKeys(catalog.entries');
    expect(page).toContain('categories={availableCategories}');
    expect(page).toContain('availableCategories={availableCategories}');
  });

  test('CategorySelect no longer groups entries itself', () => {
    // Its own `groupIntoSections` call is what let the dropdown and the grid
    // disagree about which categories exist.
    const start = browse.indexOf('export function CategorySelect');
    const end = browse.indexOf('function CatalogAffordance');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(browse.slice(start, end)).not.toContain('groupIntoSections');
  });

  test('the grid resolves the category instead of trusting it', () => {
    // `searching ? ALL_CATEGORIES : category` was the old line. It handled the
    // search case and nothing else — a category absent from the current
    // entries went straight through and emptied the grid.
    expect(browse).toContain(
      'resolveActiveCategory(category, availableCategories, { searching })',
    );
    expect(browse).not.toContain('searching ? ALL_CATEGORIES : category');
  });

  test('starting a search clears the category rather than hiding it', () => {
    // The `Select` unmounts while a search runs, so a category left applied is
    // one the user can neither see nor undo.
    expect(page).toContain('if (next.trim().length > 0) setCategory(ALL_CATEGORIES);');
    expect(page).toContain('onChange={(event) => onQueryChange(event.target.value)}');
    // Every path that writes the query must funnel through `onQueryChange`, so
    // `setQuery` may appear exactly twice: the `useState` destructure and the
    // single call inside the callback. A third occurrence means some control
    // writes the query directly and skips the category reset — the hole this
    // whole test exists to close. Asserting the funnel rather than naming the
    // controls also survives a control being added or removed.
    expect(page.match(/setQuery/g)).toHaveLength(2);
  });
});
