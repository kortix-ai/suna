/**
 * Ranking and filtering over a loaded Pipedream catalogue snapshot.
 *
 * Pure by design — no fetch, no cache, no clock — so the ordering rules can be
 * tested against fixtures instead of against the network.
 *
 * **Why rank at all, when Pipedream already answers `q`.** Its `q` is a decent
 * matcher but an alphabetical sorter. On the live catalogue `q=notion` returns
 * `cloudpress, notion, notion_api_key`: the exact match lands second, behind an
 * app that merely mentions Notion in its description. `q=gith` returns `bit_io`
 * before `github`. Once the whole catalogue is in memory the ordering is ours
 * to fix, and an exact-name match belongs first.
 */

export interface CatalogApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  authType: string | null;
  categories: string[];
  hasActions: boolean;
  hasTriggers: boolean;
  /** Pipedream's own promotion weight. Higher is more prominent. Mostly 0. */
  featuredWeight: number;
}

/**
 * Match scores, highest wins. The gaps are wide on purpose: no number of weak
 * matches should ever add up to outrank a strong one, because these are picked
 * per app rather than summed.
 */
const SCORE = {
  exact: 100,
  /** The query is a whole word of the name. Above `namePrefix` because a name
   *  that merely *starts with* the letters is usually a different product:
   *  `q=SAP` must put "SAP S/4HANA Cloud" above "Sapling.ai". */
  nameWord: 90,
  namePrefix: 80,
  nameWordPrefix: 60,
  nameSubstring: 40,
  slugSubstring: 30,
  description: 10,
  none: 0,
} as const;

/** Fold a slug, name or query into one comparable token stream. Pipedream
 *  slugs are snake_case (`google_sheets`) and names are spaced and punctuated
 *  (`Google Sheets`), so a user typing either must reach the same record. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreApp(app: CatalogApp, query: string): number {
  const name = normalize(app.name);
  const slug = normalize(app.slug);
  if (name === query || slug === query) return SCORE.exact;
  // `normalize` collapsed every separator to a single space, so padding both
  // sides is an exact whole-word test.
  if (` ${name} `.includes(` ${query} `)) return SCORE.nameWord;
  if (name.startsWith(query)) return SCORE.namePrefix;
  // A word boundary inside the name: "sheets" should reach "Google Sheets".
  // `normalize` already collapsed every separator to a single space, so a
  // leading-space probe is the whole rule.
  if (name.includes(` ${query}`)) return SCORE.nameWordPrefix;
  if (name.includes(query)) return SCORE.nameSubstring;
  if (slug.includes(query)) return SCORE.slugSubstring;
  if (app.description && normalize(app.description).includes(query)) return SCORE.description;
  return SCORE.none;
}

/**
 * The catalogue's resting order: promotion weight, then usable-before-inert,
 * then name.
 *
 * Used whenever there is no query — browsing, a category view, and each
 * section's top slice — so a category's first six cards are its most prominent
 * six rather than whichever six the crawl happened to reach first.
 *
 * **Why `hasActions` sorts rather than filters.** 1,263 of the 3,230 catalogue
 * apps publish no actions, so a connector built on one carries zero agent
 * tools. They used to be excluded outright, which made 39% of the catalogue
 * unreachable by *any* query including an app's own exact name — the reported
 * "SAP returns nothing" bug. Ranking them last inside their own weight band
 * keeps browse leading with apps the user can actually use, while leaving every
 * record findable. The card says which is which.
 */
export function compareByProminence(a: CatalogApp, b: CatalogApp): number {
  if (a.featuredWeight !== b.featuredWeight) return b.featuredWeight - a.featuredWeight;
  if (a.hasActions !== b.hasActions) return a.hasActions ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Apps matching `query`, best first. A blank query returns everything in
 * resting order rather than nothing — this is the browse path as well as the
 * search path.
 *
 * **Match strength outranks usability.** `hasActions` breaks ties *within* a
 * score band and never across one, so `q=SAP` answers with "SAP S/4HANA Cloud"
 * (score 90, no actions) above "Sapling.ai" (score 80, actions). Sorting it any
 * higher would reinstate the old bug in a softer form: the app the user named
 * would sit below apps that merely mention it.
 */
export function rankApps(apps: readonly CatalogApp[], query: string): CatalogApp[] {
  const needle = normalize(query);
  if (!needle) return [...apps].sort(compareByProminence);

  const scored: Array<{ app: CatalogApp; score: number }> = [];
  for (const app of apps) {
    const score = scoreApp(app, needle);
    if (score > SCORE.none) scored.push({ app, score });
  }
  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.app.hasActions !== b.app.hasActions) return a.app.hasActions ? -1 : 1;
      return compareByProminence(a.app, b.app);
    })
    .map((entry) => entry.app);
}

/** Apps in one category. Category keys are Pipedream's own strings, compared
 *  exactly — the snapshot builds the facet list from the same values, so there
 *  is no vocabulary to reconcile. */
export function filterByCategory(apps: readonly CatalogApp[], category: string): CatalogApp[] {
  return apps.filter((app) => app.categories.includes(category));
}

export interface CatalogPage<T> {
  items: T[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * One page of an already-ordered list.
 *
 * The cursor is a stringified offset. That is safe here and would not be
 * against the live API: the list is a snapshot the server holds whole, so an
 * offset addresses the same element on the next request. It is deliberately
 * opaque to the client, which only ever echoes it back.
 */
export function pageOf<T>(items: readonly T[], cursor: string | undefined, limit: number): CatalogPage<T> {
  const parsed = cursor ? Number.parseInt(cursor, 10) : 0;
  const offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const end = offset + limit;
  const slice = items.slice(offset, end);
  const hasMore = end < items.length;
  return {
    items: slice,
    total: items.length,
    ...(hasMore ? { nextCursor: String(end) } : {}),
    hasMore,
  };
}
