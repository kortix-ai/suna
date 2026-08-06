import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURATED_SECTIONS } from './connector-categories';

/**
 * The source with its comments removed.
 *
 * Every rule below is explained in a doc comment that names the thing it
 * forbids — "there is no Load more button" contains `Load more`. Asserting
 * against the raw file makes prose fail the test and, worse, makes deleting
 * the explanation a way to pass it. Same reason
 * `connectors-page.error-path.test.ts` scopes its `AddAppPanel` check to the
 * import block.
 *
 * Block comments cover JSDoc and JSX `{/* … *\/}`; the line-comment pass is
 * anchored to the start of a line so a `https://` inside a string survives.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const browse = code(readFileSync(join(import.meta.dir, 'connector-browse.tsx'), 'utf8'));
const page = code(readFileSync(join(import.meta.dir, '..', 'connectors-page.tsx'), 'utf8'));

/**
 * A source-assertion tripwire, in the shape of
 * `connectors-page.error-path.test.ts`.
 *
 * Each rule below is a UX decision that a plausible-looking refactor undoes
 * silently: the page still compiles, still renders cards, and still fetches —
 * it just goes back to the shape that was rejected. None of them can be
 * expressed as a unit test of a pure function, because the thing being pinned
 * is which component renders what.
 */
describe('the catalogue browses in place', () => {
  test('a category section has no carousel and no ‹ › paging', () => {
    // Arrow paging made the user operate a section to read it, two rows at a
    // time. A carousel would additionally hide cards behind a gesture.
    expect(browse).not.toContain('CaretLeftIcon');
    expect(browse).not.toContain('CaretRightIcon');
    expect(browse).not.toContain('overflow-x-auto');
    expect(browse).not.toContain('snap-x');
  });

  test('"View all" expands the section instead of filtering the page', () => {
    // The regression: `onViewAll` set the page's shared `category`, which
    // flipped `showSections` false and deleted every OTHER section from the
    // screen. Expansion has to be state local to the section.
    expect(browse).not.toContain('onViewAll');
    expect(browse).toContain('const [expanded, setExpanded] = useState(false)');
    expect(browse).toContain("expanded ? 'Show less' : 'View all'");

    // The section renders everything it has when expanded, and only the cap
    // when it does not.
    expect(browse).toContain('const visible = expanded ? items : items.slice(0, CATEGORY_ROW_CAP)');

    // `ConnectorBrowse` can no longer change the category at all — the
    // `Select` in the page owns that, and nothing else does.
    expect(browse).not.toContain('onCategoryChange');
    expect(page).not.toContain('onCategoryChange=');
  });

  test('the catalogue does not paginate — no button and no scroll auto-load', () => {
    // Both gestures were built on this page and both were rejected. Browsing
    // shows the first page; SEARCH is what reaches the rest, because it runs
    // server-side across the whole catalogue.
    expect(browse).not.toContain('Load more');
    expect(browse).not.toContain('useCatalogAutoload');
    expect(browse).not.toContain('IntersectionObserver');
    expect(browse).not.toContain('sentinel');
    expect(browse).not.toContain('fetchNextPage');
    expect(browse).not.toContain('hasNextPage');
  });

  test('nothing else in the feature still offers a next page', () => {
    // The hook and the scroll-root context existed only for auto-load, so
    // leaving either behind leaves a live `IntersectionObserver` with no
    // consumer.
    //
    // `use-catalog.ts` DOES call `fetchNextPage` now — a bounded background
    // prefetch that gives each category real depth. That is not pagination and
    // this test does not ban it. What must stay true is that no CONSUMER can
    // page: the prefetch is internal, capped, and unreachable from any control.
    // So the assertion is scoped to the exported `CatalogState`, which is the
    // only thing a component can reach.
    const catalog = code(readFileSync(join(import.meta.dir, 'use-catalog.ts'), 'utf8'));
    const stateStart = catalog.indexOf('export interface CatalogState {');
    const stateEnd = catalog.indexOf('}', stateStart);
    expect(stateStart).toBeGreaterThan(-1);
    const state = catalog.slice(stateStart, stateEnd);
    expect(state).not.toContain('hasNextPage');
    expect(state).not.toContain('fetchNextPage');
    expect(state).not.toContain('isFetchingNextPage');

    // The prefetch is bounded by a page count. An unbounded one would walk all
    // ~120 pages of a 5,758-item catalogue on every load.
    expect(catalog).toContain('maxPages: CATALOG_PREFETCH_PAGES');

    // `getNextPageParam` and `useInfiniteQuery` DO survive, and that is not an
    // oversight: they keep the react-query cache shape identical to
    // `discover-catalogue.tsx` and `AppCatalogue`, which share these exact
    // query keys. Swapping to `useQuery` would fork the cache.
    expect(catalog).toContain('useInfiniteQuery');

    expect(existsSync(join(import.meta.dir, '..', '..', 'use-catalog-autoload.ts'))).toBe(false);
    expect(existsSync(join(import.meta.dir, '..', '..', 'capability-scroll-root.tsx'))).toBe(false);
  });

  test('the page still says how much of the catalogue is on screen', () => {
    // Without pagination the grid just stops. A page that ends at 48 of 5,758
    // with no remark reads as a catalogue of 48, so this line is the
    // replacement for the removed control, not a leftover of it.
    expect(browse).toContain('entries.length < total');
    expect(browse).toContain('Search to reach the rest.');
  });

  test('headings and the category filter both read the curated sections', () => {
    // `groupIntoSections` buckets by curated section key, not by raw catalogue
    // category, and `sectionTitle` is what turns that key into a heading.
    // Reaching for the old `groupByCategory` / `humanizeCategory` here is a
    // `ReferenceError` at runtime but NOT a test failure on its own — every
    // other test in this suite reads the file as text or exercises the pure
    // module, so all of them stayed green while three call sites in this file
    // were reverted to the old names. That is what this pins.
    expect(browse).toContain('groupIntoSections(entries, (entry) => entry.categories)');
    expect(browse).toContain('const label = sectionTitle(category)');
    expect(browse).toContain('{sectionTitle(category)}');
    expect(browse).not.toContain('groupByCategory');
    expect(browse).not.toContain('humanizeCategory');
  });

  test('every curated section has its own glyph', () => {
    // `CATEGORY_ICON` is keyed by FOLDED section key, so a curated key that is
    // absent here silently renders as the generic `FolderIcon` — a visual
    // regression nothing else in this suite can see, and one that has already
    // happened once on this branch when an edit to this map was reverted.
    for (const section of CURATED_SECTIONS) {
      expect(browse).toContain(`  ${section.key.replace(/-/g, '')}:`);
    }
  });

  test('the shell is back to a plain scroll box', () => {
    // It carried a callback ref into state purely to publish that element to
    // the observer. With the observer gone the state is dead weight, and a
    // `useState` in a shell three pages render is a re-render nothing needs.
    const shell = code(
      readFileSync(join(import.meta.dir, '..', '..', 'shared', 'capability-page-shell.tsx'), 'utf8'),
    );
    expect(shell).toContain('overflow-y-auto');
    expect(shell).not.toContain('useState');
    expect(shell).not.toContain('CapabilityScrollRoot');
  });
});

/**
 * The reveal motion. Every value here is a budget, not a taste call, so each
 * one is asserted rather than left to drift back under a "make it feel
 * grander" edit.
 */
describe('the View all reveal stays inside the motion budget', () => {
  const css = readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', 'app', 'globals.css'),
    'utf8',
  );

  test('the whole reveal finishes under 300ms, however many cards appear', () => {
    // 200ms duration + a capped 3 x 30ms delay = 290ms for the last card.
    // Uncapped, a 20-card expansion would have run past a second.
    const step = Number(browse.match(/REVEAL_STEP_MS = (\d+)/)?.[1]);
    const maxSteps = Number(browse.match(/REVEAL_MAX_STEPS = (\d+)/)?.[1]);
    const duration = Number(css.match(/animation: kx-card-reveal (\d+)ms/)?.[1]);
    expect(step).toBeGreaterThan(0);
    expect(maxSteps).toBeGreaterThan(0);
    expect(duration).toBeGreaterThan(0);
    expect(step * maxSteps + duration).toBeLessThanOrEqual(300);
  });

  test('it uses its own keyframe, not the page-enter one', () => {
    // `.kx-fade-up` is page-enter motion for a few large blocks. Reusing it on
    // 20+ dense cards is what made the reveal read as a wave.
    expect(browse).toContain('kx-card-reveal');
    expect(browse).not.toContain('kx-fade-up');
    expect(css).toContain('@keyframes kx-card-reveal');
  });

  test('reduced motion drops the stagger as well as the movement', () => {
    // The delay must travel as a custom property. An inline `animationDelay`
    // outranks the stylesheet, so the media query could strip the transform
    // but never the staged reveal.
    expect(browse).toContain("'--kx-card-reveal-delay'");
    expect(browse).not.toContain('animationDelay');
    expect(css).toContain('animation-delay: var(--kx-card-reveal-delay, 0ms)');

    const reduced = css.slice(css.indexOf('.kx-card-reveal {'));
    const query = reduced.slice(reduced.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(query).toContain('animation-name: kx-fade');
    expect(query).toContain('animation-delay: 0ms');
  });

  test('it travels less than the page-enter motion it replaced', () => {
    // 8px per card across a dense grid is collective motion, not arrival.
    const keyframe = css.slice(css.indexOf('@keyframes kx-card-reveal'));
    expect(keyframe).toContain('translateY(4px)');
  });

  test('the easing is the strong ease-out, never ease-in', () => {
    // Entering elements accelerate at the start; ease-in delays the exact
    // moment the user is watching.
    expect(css).toContain('kx-card-reveal 200ms cubic-bezier(0.23, 1, 0.32, 1)');
  });
});

describe('the connectors page has three tabs', () => {
  test('Discovery, All, Connected — and no Available', () => {
    expect(page).toContain(
      "const SCOPES: readonly ConnectorScope[] = ['discover', 'all', 'connected'];",
    );
    expect(page).toContain("discover: 'Discovery'");
    expect(page).not.toContain("'available'");
  });

  test('no tab filters connected apps out of the catalogue', () => {
    // Available was the catalogue minus what the project has. Every card it
    // removed already carried a `✓` on the other two tabs, so it only ever
    // made an app the user could see was connected disappear.
    expect(page).not.toContain('isCatalogEntryConnected');

    // `ConnectorBrowse` reads `state.entries` directly, so there is no second
    // list the page could hand it that disagrees with the one it pages. The
    // check is scoped to that element: `CategorySelect` legitimately takes an
    // `entries` prop, and a bare file-wide search would match it instead.
    const start = page.indexOf('<ConnectorBrowse');
    expect(start).toBeGreaterThan(-1);
    const element = page.slice(start, page.indexOf('/>', start));
    expect(element).not.toContain('entries=');
  });
});
