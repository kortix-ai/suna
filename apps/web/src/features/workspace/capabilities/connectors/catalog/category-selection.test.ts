import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const page = code(readFileSync(join(import.meta.dir, '..', 'connectors-page.tsx'), 'utf8'));
const browse = code(readFileSync(join(import.meta.dir, 'connector-browse.tsx'), 'utf8'));

/**
 * How the page and the grid agree on which category is open.
 *
 * This file used to also unit-test `resolveActiveCategory` and
 * `catalogCategoryKeys`, which reconciled a picked category against the
 * categories present in the loaded pages. Both are deleted: a category is a
 * server-side filter over the whole catalogue now, so "absent from the entries
 * on screen" no longer implies "does not exist", and there is no derived
 * vocabulary for two surfaces to disagree about.
 *
 * What remains is the wiring, which is still one plausible-looking edit away
 * from breaking silently.
 */
describe('the page wires the filter to one derivation', () => {
  test('the category vocabulary comes from the API, derived nowhere', () => {
    // `catalogCategoryKeys(catalog.entries, …)` used to build this list from
    // the pages that happened to be loaded, so the set of categories the page
    // offered was a function of how far the user had scrolled. The API now
    // publishes every category with its true count
    // (`pipedreamCatalogPage` -> `categories`), so there is nothing to derive
    // and nothing for two surfaces to disagree about.
    expect(page).not.toContain('catalogCategoryKeys');
    expect(page).not.toContain('availableCategories');
    expect(browse.match(/catalogCategoryKeys/g)).toBeNull();
    expect(browse).toContain('state.categories.find((facet) => facet.key === activeCategory)');
  });

  test('a search still overrides an open category', () => {
    // The one rule `resolveActiveCategory` carried that still applies. The
    // rest of it — degrading a category absent from the loaded entries — is
    // obsolete: a category is a server-side filter over the whole catalogue,
    // so "absent from the entries on screen" no longer means "does not exist".
    expect(browse).toContain('const activeCategory = searching ? ALL_CATEGORIES : category;');
    expect(browse).not.toContain('resolveActiveCategory');
  });

  test('starting a search clears the category rather than hiding it', () => {
    // The rail unmounts while a search runs, so a category left applied is one
    // the user can neither see nor undo.
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
