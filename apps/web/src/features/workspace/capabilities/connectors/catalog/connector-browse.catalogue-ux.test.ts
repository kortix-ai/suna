import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from '@/i18n/test-source';
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
const browseSectionsSource = code(readFileSync(join(here, 'browse-sections.ts'), 'utf8'));
const autoload = code(readFileSync(join(here, 'use-catalog-autoload.ts'), 'utf8'));
const paging = code(readFileSync(join(here, 'catalog-paging.ts'), 'utf8'));
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

  test('there is exactly ONE way the catalogue grows', () => {
    // Reported as "load more feels janky". There used to be three mechanisms
    // stacked: eager first-paint pages, a per-category auto-deepening effect
    // chain, and a client-side reveal window over the grid. A scroll sometimes
    // uncovered already-loaded cards and sometimes fetched, and the user had no
    // way to tell which — so the grid grew at two different rates.
    //
    // Now: `hasMore` is the query's, and `loadMore` is the query's. Nothing
    // else grows the grid.
    expect(browse).toContain('const hasMore = state.hasMore;');
    expect(browse).toContain('const loadMore = state.loadMore;');

    // The reveal window is gone, not merely unused.
    expect(browse).not.toContain('canRevealMore');
    expect(browse).not.toContain('nextRevealCount');
    expect(browse).not.toContain('revealed');
  });

  test('there is a control as well as a gesture', () => {
    // Infinite scroll is not reachable from a keyboard. The button is the
    // accessible path, not a fallback, so it is rendered whenever there is
    // more to fetch rather than only when the observer is missing.
    expect(browse).toContain('Load more');
    expect(browse).toContain('onClick={loadMore}');
  });

  test('the page does NO paging on its own', () => {
    // There is no unattended budget any more, so there is nothing to cap. The
    // effect chain that fetched four pages on every load — and kept fetching
    // while a client-side category bucket looked thin — is gone with the
    // client-side category filter it was compensating for.
    expect(catalog).not.toContain('shouldAutoLoadPage');
    expect(catalog).not.toContain('CATALOG_INITIAL_PAGES');
    expect(catalog).not.toContain('CATALOG_AUTOLOAD_MAX_PAGES');
    expect(catalog).not.toContain('CATALOG_FOCUS_TARGET');

    // Scrolling stays uncapped: reaching the foot is an explicit request, and
    // answering it with a ceiling is the original regression.
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

  test('a category is a SERVER-side filter, not a slice of loaded pages', () => {
    // The bug behind "category-based discovery doesn't work — you always just
    // take the ones from the current page". Pipedream's /apps endpoint accepts
    // a category parameter and ignores it, so a client-side slice was the only
    // option and every category was a sample of the first few pages. The API
    // filters against its own snapshot of the whole catalogue now.
    expect(catalog).toContain('...(category ? { category } : {})');

    // The category is part of the query KEY. Without it, changing category
    // would re-slice an accumulated list instead of starting a new one.
    expect(catalog).toContain("queryKey: ['easy-connect-apps', projectId, activeQuery, category]");

    // No client-side bucketing of loaded entries to fake a category.
    expect(catalog).not.toContain('countInSection');
  });

  test('the browse page is fetched, not bucketed', () => {
    // One request returns a fixed top slice of each of the largest categories,
    // each with the category's TRUE total. `total` is what lets a heading say
    // "Marketing · 207" over six cards; deriving it from `items.length` would
    // put the loaded count back on the heading.
    expect(catalog).toContain('listPipedreamSections');
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

  test('the page still says how much of the catalogue is on screen', () => {
    // The grid stops somewhere. A page that ends at 192 of 2,713 with no
    // remark reads as a catalogue of 192.
    expect(browse).toContain('catalogFootSummary');
    expect(browse).toContain('tabular-nums');
  });

});

/**
 * Card entry motion — and the case for not having any.
 *
 * This block used to assert a per-card staggered reveal: `REVEAL_STEP_MS`,
 * `REVEAL_MAX_STEPS`, a `--kx-card-reveal-delay` custom property, and a
 * `.kx-card-reveal` keyframe. Every value was budgeted and asserted, and none
 * of it ever ran — `CatalogEntryCard` took a `reveal` prop that both call
 * sites omitted, so `reveal` was always `null` and the class was never
 * applied. The tests passed by reading the source, which is exactly the blind
 * spot a source-assertion suite has.
 *
 * It is not being restored. A staggered entrance is right for a handful of
 * arriving items and wrong for a page appending 48 cards at once — that reads
 * as a wave, which is the "load more feels janky" complaint. The grid now
 * appends without per-card motion, and the skeletons already occupy the
 * positions the new cards take, so nothing jumps.
 */
describe('appended cards do not stagger', () => {
  const css = readFileSync(join(here, '..', '..', '..', '..', '..', 'app', 'globals.css'), 'utf8');

  test('no per-card reveal delay survives in the grid', () => {
    expect(browse).not.toContain('kx-card-reveal');
    expect(browse).not.toContain('REVEAL_STEP_MS');
    expect(browse).not.toContain('animationDelay');
    // The prop is gone too, so a future call site cannot re-enable a stagger
    // that nothing else in this suite would notice.
    expect(browse).not.toContain('reveal');
  });

  test('the orphaned keyframe went with it', () => {
    // Its only consumer was deleted. CSS that nothing references is a trap:
    // the next reader assumes a stagger exists somewhere and goes looking.
    expect(css).not.toContain('kx-card-reveal');
  });

  test('a landing page still lands into reserved space', () => {
    // What replaces the motion: skeletons rendered INSIDE the grid, so the
    // real cards take the positions the placeholders already held.
    expect(browse).toContain('CatalogCardSkeleton');
    expect(browse).toContain('state.isLoadingMore');
  });

  test('the card is memoised — a browse page renders 72 of them', () => {
    expect(browse).toContain('const CatalogEntryCard = memo(');
  });
});

describe('the connectors page has three tabs', () => {
  test('All, Connected, Channels — and no Discovery or Available', () => {
    expect(page).toContain(
      "const SCOPES: readonly ConnectorScope[] = ['all', 'connected', 'channels'];",
    );
    // `'discover'` is still a catalogue SOURCE (`catalogSource`), never a tab.
    expect(page).not.toContain("scope === 'discover'");
    expect(page).not.toContain("s !== 'discover'");
    expect(browse).not.toContain('sectioned');
    expect(page).toContain("channels: 'Channels'");
    expect(page).not.toContain("'available'");
  });

  // Channels is the one scope that is not a narrower view of the connector
  // list — it replaces the body. So the two controls that only act on that
  // list come off with it: the search box searches the catalogue, and Add
  // opens a custom-CONNECTOR form.
  test('the Channels scope drops the connector search and the Add button', () => {
    expect(page).toContain("const channelsActive = scope === 'channels';");
    expect(page).toContain('channelsActive ? undefined : (');
    expect(page).toContain('canWrite && !channelsActive ?');
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
