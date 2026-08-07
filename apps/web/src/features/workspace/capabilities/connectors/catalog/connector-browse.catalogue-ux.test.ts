import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURATED_SECTIONS } from './connector-categories';

/**
 * The source with its comments removed.
 *
 * Every rule below is explained in a doc comment that names the thing it
 * forbids — "there is no carousel" contains `carousel`. Asserting against the
 * raw file makes prose fail the test and, worse, makes deleting the
 * explanation a way to pass it. Same reason
 * `connectors-page.error-path.test.ts` scopes its `AddAppPanel` check to the
 * import block.
 *
 * Block comments cover JSDoc and JSX `{/* … *\/}`; the line-comment pass is
 * anchored to the start of a line so a `https://` inside a string survives.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const here = import.meta.dir;
const capabilities = join(here, '..', '..');

const browse = code(readFileSync(join(here, 'connector-browse.tsx'), 'utf8'));
const page = code(readFileSync(join(here, '..', 'connectors-page.tsx'), 'utf8'));
const catalog = code(readFileSync(join(here, 'use-catalog.ts'), 'utf8'));
const autoload = code(readFileSync(join(here, 'use-catalog-autoload.ts'), 'utf8'));
const paging = code(readFileSync(join(here, 'catalog-paging.ts'), 'utf8'));
const icons = readFileSync(join(here, 'category-icon.tsx'), 'utf8');
const shell = code(readFileSync(join(capabilities, 'shared', 'capability-page-shell.tsx'), 'utf8'));

/**
 * A source-assertion tripwire, in the shape of
 * `connectors-page.error-path.test.ts`.
 *
 * Each rule below is a UX decision that a plausible-looking refactor undoes
 * silently: the page still compiles, still renders cards, and still fetches —
 * it just goes back to a shape that was rejected. None of them can be expressed
 * as a unit test of a pure function, because the thing being pinned is which
 * component renders what.
 */
describe('the catalogue reaches the whole catalogue', () => {
  test('scrolling to the foot loads the next page', () => {
    // THE REGRESSION THIS FILE ONCE PROTECTED, NOW REVERSED. An earlier
    // revision of this suite asserted the opposite — that `connector-browse`
    // contained no `IntersectionObserver`, no sentinel and no `fetchNextPage`
    // — on the reasoning that browsing should show one page and SEARCH should
    // reach the rest.
    //
    // That reasoning does not survive the numbers. One page is 48 apps against
    // a catalogue of ~2,700, spread over ~11 category sections. It left every
    // section a sample of a sample, made the category list itself a function of
    // which categories happened to appear in page 1, and made "View all" a
    // label the page could not honour. Search only reaches the rest if you
    // already know the name of the thing you want, which is the one case
    // browsing is not for.
    expect(browse).toContain('useCatalogAutoload');
    expect(browse).toContain('ref={sentinelRef}');
    expect(autoload).toContain('IntersectionObserver');
    expect(autoload).toContain('shouldLoadOnScroll');
  });

  test('the observer watches the shell, never the viewport', () => {
    // The `(capabilities)` layout wraps the shell in `overflow-hidden`, so a
    // sentinel inside it intersects the viewport never. An observer left on
    // its default root does not error and does not warn — it silently never
    // fires, and the only symptom is a grid that stops growing.
    expect(autoload).toContain('useCapabilityScrollRoot');
    expect(autoload).toContain('nearestScrollParent');
    expect(shell).toContain('CapabilityScrollRootProvider');
    expect(shell).toContain('ref={scrollRef}');
    expect(existsSync(join(capabilities, 'shared', 'capability-scroll-root.tsx'))).toBe(true);
  });

  test('the root is resolved in a PASSIVE effect, never a layout effect', () => {
    // THIS BUG SHIPPED, and it is invisible in review. React attaches host refs
    // and runs layout effects in one depth-first pass, CHILDREN BEFORE PARENTS,
    // so an ancestor's ref is still null when a descendant's layout effect
    // runs. Resolving the root there yielded null; `setState(null)` on
    // already-null state bails out without re-rendering; the effect's only dep
    // was the ref object, which never changes. The root stayed null forever and
    // the observer silently watched a viewport the sentinel cannot reach.
    //
    // Passive effects run after the whole commit, when every ref is attached.
    expect(autoload).not.toContain('useLayoutEffect');
    expect(autoload).not.toContain('setScrollRoot');

    // And a DOM walk backs it up, so a ref handoff that fails for any other
    // reason still cannot leave the observer on the viewport.
    expect(autoload).toContain('scrollRootRef.current ?? nearestScrollParent(node)');
  });

  test('the grid grows in rows while the network fetches in pages', () => {
    // Asking the API for 6 at a time would turn ~2,700 apps into ~450 round
    // trips. Jumping the grid by 48 whenever one lands is the other extreme.
    // The reveal window is what separates the two.
    expect(browse).toContain('canRevealMore');
    expect(browse).toContain('nextRevealCount');
    expect(browse).toContain('flat.slice(0, revealed)');

    // Uncovering is checked BEFORE the network. Reversed, every scroll would
    // cost a request while the answer was already in memory.
    expect(browse).toContain('const hasMore = canReveal || state.hasMore;');
  });

  test('the reveal window is not applied to the sectioned view', () => {
    // Sections are their own window — each caps at `CATEGORY_ROW_CAP`. Slicing
    // `flat` in that shape would make the sentinel "uncover" cards nothing is
    // rendering, and scrolling the Discovery tab would do nothing at all.
    expect(browse).toContain('const canReveal = !showSections && canRevealMore(revealed, flat.length)');
  });

  test('there is a control as well as a gesture', () => {
    // Infinite scroll is not reachable from a keyboard. The button is the
    // accessible path, not a fallback, so it is rendered whenever there is
    // more to fetch rather than only when the observer is missing.
    expect(browse).toContain('Load more');
    expect(browse).toContain('onClick={loadMore}');
  });

  test('the automatic budget is capped and the user-driven one is not', () => {
    // The distinction the whole design rests on. Work the page does on its own
    // is bounded, because nothing the user did asked for ~120 sequential
    // requests. Work the user asked for by scrolling is not bounded, because
    // capping it is the regression.
    expect(catalog).toContain('maxPages: CATALOG_AUTOLOAD_MAX_PAGES');
    const scrollRule = paging.slice(paging.indexOf('export function shouldLoadOnScroll'));
    expect(scrollRule).not.toContain('maxPages');
    expect(scrollRule).not.toContain('loadedPages');
  });

  test('a component can actually reach the next page', () => {
    // `CatalogState` deliberately omitted every paging field, so no consumer
    // could page even if it wanted to. That omission WAS the regression: the
    // page had a bounded background prefetch and no way past it.
    const stateStart = catalog.indexOf('export interface CatalogState {');
    const stateEnd = catalog.indexOf('\n}', stateStart);
    expect(stateStart).toBeGreaterThan(-1);
    const state = catalog.slice(stateStart, stateEnd);
    expect(state).toContain('hasMore');
    expect(state).toContain('isLoadingMore');
    expect(state).toContain('loadMore');
  });

  test('a focused category keeps fetching until it has something to show', () => {
    // Neither catalogue API accepts a category, so a category view is a
    // client-side slice of the loaded pages. Without this the slice is however
    // many of that category happened to fall in the first four pages — which
    // is how "View all" on Finance opened eight cards.
    expect(catalog).toContain('focusCategory');
    expect(catalog).toContain('CATALOG_FOCUS_TARGET');
    expect(page).toContain('focusCategory');

    // Counted with the same membership rule the grid buckets by. A second,
    // hand-written rule is how a page fetches forever against a target the
    // grid has already met.
    expect(catalog).toContain('countInSection');
  });

  test('useInfiniteQuery survives, and not by accident', () => {
    // `discover-catalogue.tsx` and `AppCatalogue` cache a `{pages, pageParams}`
    // shape under these exact query keys. Swapping to `useQuery` forks the
    // cache and reintroduces the duplicate fetch the shared keys prevent.
    expect(catalog).toContain('useInfiniteQuery');
  });
});

describe('the catalogue browses in place', () => {
  test('a category section is a grid, not a carousel', () => {
    // A horizontally scrolling row would hide cards behind a gesture and break
    // the grid's column rhythm. `CaretRightIcon` is allowed — it is the
    // chevron on "See all" — but there is no "previous", because there is
    // nothing to go back to.
    expect(browse).not.toContain('CaretLeftIcon');
    expect(browse).not.toContain('overflow-x-auto');
    expect(browse).not.toContain('snap-x');
    expect(browse).toContain('GRID_CLASSNAME');
  });

  test('the button says "View all", and opens the category', () => {
    // The label is the old one and the behaviour behind it is not: expansion
    // could never keep the promise it made, because a section only ever held
    // what the loaded pages happened to contain — "View all" on Finance opened
    // 8 cards out of ~2,700. Opening the category puts it in front of both
    // fetchers, so the label is now true.
    expect(browse).toContain('View all');
    expect(browse).toContain('onViewAll');
    expect(browse).toContain('const visible = items.slice(0, CATEGORY_ROW_CAP)');
    expect(browse).not.toContain('setExpanded');
    expect(browse).not.toContain("expanded ? 'Show less' : 'View all'");
    expect(browse).not.toContain('See all');
  });

  test('an open category can be left, and says which one it is', () => {
    // The only thing in-place expansion was protecting against: a page that
    // swaps every section for one grid and gives no account of itself. One
    // heading row with a Back control is that account.
    expect(browse).toContain('function CategoryViewHeader');
    expect(browse).toContain('aria-label="Back to all connectors"');
    expect(browse).toContain('onBack={() => openCategory(ALL_CATEGORIES)}');
  });

  test('opening or leaving a category returns the user to the top', () => {
    // The gesture replaces a page of sections with one grid, and Back replaces
    // it again. Keeping the scroll offset lands the user mid-grid on a view
    // they just arrived at the top of.
    expect(browse).toContain('scrollRootRef.current?.scrollTo');
    expect(browse).toContain('prefers-reduced-motion: reduce');
  });

  test('there is NO persistent category strip above the catalogue', () => {
    // Rejected on sight, and this is the pin. A row of every category standing
    // above the grid at all times is a second navigation layer on a page that
    // already has tabs, and it turns a category from a place you go into a
    // switch you have to notice is flipped. The catalogue is the page; a
    // category is reached through "View all" and left through Back.
    expect(browse).not.toContain('CategoryRail');
    expect(browse).not.toContain('CategorySelect');
    expect(page).not.toContain('CategoryRail');
    expect(page).not.toContain('CategorySelect');
    expect(existsSync(join(here, 'category-rail.tsx'))).toBe(false);

    // The heading that DOES exist is scoped to an open category. If it ever
    // renders while browsing everything, it has become the strip this forbids.
    expect(browse).toContain("activeCategory !== ALL_CATEGORIES ? (\n        <CategoryViewHeader");
  });

  test('the page still says how much of the catalogue is on screen', () => {
    // The grid stops somewhere. A page that ends at 192 of 2,713 with no
    // remark reads as a catalogue of 192.
    expect(browse).toContain('catalogFootSummary');
    expect(browse).toContain('tabular-nums');
  });

  test('headings and the rail both read the curated sections', () => {
    // `groupIntoSections` buckets by curated section key, not by raw catalogue
    // category, and `sectionTitle` is what turns that key into a heading.
    // Reaching for the old `groupByCategory` / `humanizeCategory` here is a
    // `ReferenceError` at runtime but NOT a test failure on its own — every
    // other test in this suite reads the file as text or exercises the pure
    // module, so all of them stayed green while three call sites in this file
    // were reverted to the old names. That is what this pins.
    expect(browse).toContain('groupIntoSections(entries, (entry) => entry.categories)');
    expect(browse).toContain('const label = sectionTitle(category)');
    expect(browse).not.toContain('groupByCategory');
    expect(browse).not.toContain('humanizeCategory');
  });

  test('every curated section has its own glyph', () => {
    // `CATEGORY_ICON` is keyed by FOLDED section key, so a curated key that is
    // absent silently renders as the generic `FolderIcon` — a visual
    // regression nothing else in this suite can see, and one that has already
    // happened once on this branch when an edit to this map was reverted.
    for (const section of CURATED_SECTIONS) {
      expect(icons).toContain(`  ${section.key.replace(/-/g, '')}:`);
    }
  });

  test('the glyph map has exactly one home', () => {
    // The rail and the section headings both draw these. A second copy lets
    // one surface fall back to `FolderIcon` for a category the other draws.
    expect(browse).toContain("from './category-icon'");
    expect(browse).not.toContain('const CATEGORY_ICON');
  });
});

/**
 * The reveal motion. Every value here is a budget, not a taste call, so each
 * one is asserted rather than left to drift back under a "make it feel
 * grander" edit.
 */
describe('the card reveal stays inside the motion budget', () => {
  const css = readFileSync(join(here, '..', '..', '..', '..', '..', 'app', 'globals.css'), 'utf8');

  test('the whole reveal finishes under 300ms, however many cards appear', () => {
    // 200ms duration + a capped 3 x 30ms delay = 290ms for the last card.
    // Uncapped, a 48-card page would have run past a second.
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
    // 48 dense cards is what made the reveal read as a wave.
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
    // list the page could hand it that disagrees with the one it pages.
    const start = page.indexOf('<ConnectorBrowse');
    expect(start).toBeGreaterThan(-1);
    const element = page.slice(start, page.indexOf('/>', start));
    expect(element).not.toContain('entries=');
  });
});
