/**
 * An in-memory snapshot of the whole Pipedream app catalogue.
 *
 * **Why the whole thing.** Pipedream's `/apps` endpoint cannot filter by
 * category — `?category=` and `?categories=` are both accepted and both
 * ignored, verified against the live API (`total_count` stays 3238 either way).
 * So a category is only ever a slice of whatever pages a client happened to
 * load, which is exactly the "category discovery takes the ones from the
 * current page" complaint this module exists to answer. There is no upstream
 * query that fixes it; the only honest category filter is one applied to the
 * complete catalogue, which means holding the complete catalogue.
 *
 * **Why that is affordable.** 3,238 records trim to 715 KB of JSON — 170 KB
 * gzipped — and 33 requests at `limit=100`, about 48 s wall clock. Per pod,
 * per TTL, that is nothing. The alternative (a table, a migration and a
 * scheduled job) buys only a shared crawl, and one crawl per pod per six hours
 * is not a cost worth a migration.
 *
 * **Nobody waits for it.** {@link getCatalogSnapshot} never blocks. It returns
 * whatever it has — including nothing — and schedules a refresh when the
 * snapshot is missing or stale. A caller holding `null` answers that one
 * request from the live paged API instead, and by the next request the index is
 * usually warm. That keeps the ~48 s crawl off the request path entirely,
 * including the first request after a deploy.
 */
import { isThirdPartyApp } from './pipedream-catalog';
import { compareByProminence, type CatalogApp } from './pipedream-search';

/** How long a snapshot is served before a refresh is scheduled behind it. The
 *  catalogue changes by a handful of apps a week; six hours is well inside the
 *  rate at which a new app matters. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** Pipedream's per-request maximum. 3,238 apps is 33 requests. */
const CRAWL_PAGE_SIZE = 100;

/** A crawl that walks past this many pages is looping — Pipedream would have to
 *  triple its catalogue to reach it legitimately. Bounds the damage if the
 *  cursor ever stops advancing. */
const MAX_CRAWL_PAGES = 200;

export interface CatalogCategory {
  /** Pipedream's own category string, used as both the key and the filter
   *  value. There is no separate vocabulary to map — see the module doc on
   *  `connector-categories.ts` for why the client used to need one. */
  key: string;
  label: string;
  count: number;
}

export interface CatalogSnapshot {
  /** Every catalogue app, in resting order. */
  apps: CatalogApp[];
  /**
   * Apps Pipedream publishes that expose no actions, in resting order.
   *
   * NOT part of the catalogue — a connector built on one would carry zero
   * agent tools. They are kept so a search can say why it found nothing
   * instead of implying the app does not exist. This is not hypothetical:
   * `sap_s_4hana_cloud` and `sap_s_4hana_cloud_sandbox` both ship
   * `has_actions: false`, so "SAP" — the exact query in the bug report — is
   * still an empty result, and "No matches for SAP" would still be the wrong
   * thing to say about it.
   */
  withoutActions: CatalogApp[];
  /** Category -> its apps, in resting order. Precomputed because the sections
   *  endpoint reads all 25 buckets on every call. */
  byCategory: ReadonlyMap<string, CatalogApp[]>;
  /** Facets, largest first. Counts are the true catalogue counts, which is what
   *  lets a section heading state one. */
  categories: CatalogCategory[];
  fetchedAt: number;
}

/** One page of raw records, as the provider hands them over. */
export interface RawCatalogPage {
  apps: CatalogApp[];
  nextCursor?: string;
}

/** Fetch one page of raw catalogue records. Injected so the crawl is testable
 *  without a network or a Pipedream account. */
export type CatalogPageFetcher = (
  limit: number,
  cursor: string | undefined,
) => Promise<RawCatalogPage>;

let snapshot: CatalogSnapshot | null = null;
/** The crawl in flight, if any. Single-flight: concurrent callers observing a
 *  stale snapshot must not each start their own 33-request walk. */
let inFlight: Promise<CatalogSnapshot> | null = null;

/**
 * Bucket and rank a crawled catalogue.
 *
 * Exported for the tests, and because it is the whole shape of the snapshot:
 * everything else in this module is scheduling.
 */
export function buildSnapshot(apps: readonly CatalogApp[], fetchedAt: number): CatalogSnapshot {
  const sorted = [...apps].sort(compareByProminence);
  const ordered = sorted.filter((app) => app.hasActions);
  const withoutActions = sorted.filter((app) => !app.hasActions);

  const byCategory = new Map<string, CatalogApp[]>();
  for (const app of ordered) {
    for (const category of app.categories) {
      const key = category.trim();
      if (!key) continue;
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(app);
      else byCategory.set(key, [app]);
    }
  }

  const categories = [...byCategory.entries()]
    .map(([key, items]) => ({ key, label: key, count: items.length }))
    .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.key.localeCompare(b.key)));

  return { apps: ordered, withoutActions, byCategory, categories, fetchedAt };
}

/**
 * Walk every page of the catalogue and build a snapshot.
 *
 * Stops on a missing cursor, an empty page, or a cursor that repeats — the
 * last of which is the only way a well-formed API could spin this loop.
 */
export async function crawlCatalog(
  fetchPage: CatalogPageFetcher,
  now: () => number = Date.now,
): Promise<CatalogSnapshot> {
  const apps: CatalogApp[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CRAWL_PAGES; page++) {
    const result = await fetchPage(CRAWL_PAGE_SIZE, cursor);
    for (const app of result.apps) {
      if (isThirdPartyApp(app)) apps.push(app);
    }
    const next = result.nextCursor;
    if (!next || result.apps.length === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return buildSnapshot(apps, now());
}

function isStale(current: CatalogSnapshot, now: number): boolean {
  return now - current.fetchedAt >= CATALOG_TTL_MS;
}

/**
 * The snapshot, if there is one, plus a refresh scheduled when it is missing or
 * stale.
 *
 * **Never awaits the crawl.** A stale snapshot is served as-is while the fresh
 * one is built behind it, and a missing one returns `null` so the caller can
 * fall back to the live API for that request. The returned `warming` flag is
 * what the route turns into `indexReady: false`.
 */
export function getCatalogSnapshot(
  fetchPage: CatalogPageFetcher,
  now: () => number = Date.now,
): { snapshot: CatalogSnapshot | null; warming: boolean } {
  const current = snapshot;
  const needsRefresh = current === null || isStale(current, now());

  if (needsRefresh && !inFlight) {
    inFlight = crawlCatalog(fetchPage, now)
      .then((next) => {
        snapshot = next;
        return next;
      })
      .catch((error) => {
        // A failed crawl must not poison the cache. Keeping the stale snapshot
        // (or none) means the next call retries, and the live fallback covers
        // the gap meanwhile.
        console.error('[pipedream-index] catalogue crawl failed', error);
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    // The rejection is handled above; this only stops an unhandled-rejection
    // warning on the copy nobody awaits.
    inFlight.catch(() => {});
  }

  return { snapshot: current, warming: current === null && inFlight !== null };
}

/**
 * Await the snapshot, crawling if there is none.
 *
 * Only for callers that genuinely cannot answer without it — the live e2e
 * suite, and a warm-up call at boot. Request handlers use
 * {@link getCatalogSnapshot} so nobody waits ~48 s behind a cold pod.
 */
export async function ensureCatalogSnapshot(
  fetchPage: CatalogPageFetcher,
  now: () => number = Date.now,
): Promise<CatalogSnapshot> {
  const current = snapshot;
  if (current && !isStale(current, now())) return current;
  if (inFlight) return inFlight;
  getCatalogSnapshot(fetchPage, now);
  return inFlight ?? Promise.resolve(buildSnapshot([], now()));
}

/** Drop the cached snapshot. Tests only — the TTL owns this in production. */
export function resetCatalogSnapshot(): void {
  snapshot = null;
  inFlight = null;
}
