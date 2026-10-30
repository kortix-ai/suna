import type { DiscoverSectionsPage, PipedreamCategory } from '@kortix/sdk';

import { catalogEntryFromDiscover, type CatalogEntry } from './catalog-entry';

import { POPULAR_SECTION } from './connector-categories';
import type { CatalogSection } from './use-catalog';


/** The browse page, cards already mapped. */
export interface BrowseSectionsPage {
  /** The top of the whole catalogue by rank. Only Discover ranks its apps. */
  popular: CatalogEntry[];
  sections: Array<{ key: string; label: string; total: number; items: CatalogEntry[] }>;
  categories: PipedreamCategory[];
}


/**
 * The Discover browse page. Titled by key: Discover sections are the shared
 * curated buckets, and `localizedSectionTitle` resolves a curated key to our
 * own translated title.
 */
export function sectionsPageFromDiscover(page: DiscoverSectionsPage): BrowseSectionsPage {
  return {
    popular: page.popular.map(catalogEntryFromDiscover),
    sections: page.sections.map((section) => ({
      key: section.key,
      label: section.key,
      total: section.total,
      items: section.items.map(catalogEntryFromDiscover),
    })),
    categories: page.categories.map((category) => ({
      key: category.key,
      label: category.key,
      count: category.count,
    })),
  };
}

/**
 * The sections the browse grid renders, from the server's page.
 *
 * `total` is the server's count for the whole category, never `items.length` —
 * reading the length is the bug that labelled categories `· 1`.
 *
 * Popular leads when the catalogue ranks anything. It is a per-item rank, not a
 * category, so its total is its own slice and it never offers "View all" into a
 * bucket with no more members.
 */
export function browseSections(
  page: BrowseSectionsPage,
  opts: {
    cardCount: number;
    title: (label: string) => string;
  },
): CatalogSection[] {
  const popularItems = page.popular.slice(0, opts.cardCount);
  const popular: CatalogSection[] =
    popularItems.length > 0
      ? [
          {
            key: POPULAR_SECTION,
            label: opts.title(POPULAR_SECTION),
            total: popularItems.length,
            items: popularItems,
          },
        ]
      : [];
  return popular.concat(
    page.sections.map((section) => ({
      key: section.key,
      label: opts.title(section.label),
      total: section.total,
      items: section.items.slice(0, opts.cardCount),
    })),
  );
}
