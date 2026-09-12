import type {
  ConnectSectionsPage,
  ConnectToolkit,
  DiscoverSectionsPage,
  PipedreamApp,
  PipedreamCategory,
  PipedreamSection,
} from '@kortix/sdk';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  foldKey,
  type CatalogEntry,
} from './catalog-entry';
import { POPULAR_SECTION } from './connector-categories';
import type { CatalogSection } from './use-catalog';

export type EasyConnectApp = PipedreamApp & { provider?: 'composio' | 'pipedream' };

/** The browse page in one shape for every catalogue, cards already mapped. */
export interface BrowseSectionsPage {
  /** The top of the whole catalogue by rank. Only Discover ranks its apps. */
  popular: CatalogEntry[];
  sections: Array<{ key: string; label: string; total: number; items: CatalogEntry[] }>;
  categories: PipedreamCategory[];
}

/** A Composio toolkit as the card the Easy Connect grid renders. The paged
 *  catalogue and the browse sections both use this, so a card is identical in
 *  a section and behind its "View all". */
export function connectToolkitApp(toolkit: ConnectToolkit): EasyConnectApp {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: toolkit.description ?? null,
    imgSrc: toolkit.logo,
    authType: toolkit.isNoAuth ? 'none' : 'oauth',
    categories: toolkit.categories ?? [],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    provider: 'composio',
  };
}

/**
 * The Composio browse page.
 *
 * Labels are replaced by keys. Composio's category names are lowercase
 * ("server monitoring"), and the paged grid titles a category by humanizing its
 * key — so titling by key keeps a section heading and the header of the
 * category it opens spelling the same name.
 */
export function sectionsPageFromConnect(page: ConnectSectionsPage): BrowseSectionsPage {
  return {
    popular: [],
    sections: page.sections.map((section) => ({
      key: section.key,
      label: section.key,
      total: section.total,
      items: section.toolkits.map((toolkit) => catalogEntryFromEasyConnect(connectToolkitApp(toolkit))),
    })),
    categories: page.categories.map((category) => ({
      key: category.key,
      label: category.key,
      count: category.count,
    })),
  };
}

/** The Pipedream browse page. Pipedream publishes readable labels, kept as-is. */
export function sectionsPageFromPipedream(page: {
  sections: PipedreamSection[];
  categories: PipedreamCategory[];
}): BrowseSectionsPage {
  return {
    popular: [],
    sections: page.sections.map((section) => ({
      key: section.key,
      label: section.label,
      total: section.total,
      items: section.apps.map(catalogEntryFromEasyConnect),
    })),
    categories: page.categories,
  };
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
 *
 * `native` is the Computers card. No catalogue publishes it, and the browse
 * page is where it is discovered, so it leads the section for the category it
 * claims. It does not change that section's `total`, which counts the
 * catalogue the heading's "View all" opens.
 */
export function browseSections(
  page: BrowseSectionsPage,
  opts: {
    native: CatalogEntry | null;
    cardCount: number;
    title: (label: string) => string;
  },
): CatalogSection[] {
  const nativeKeys = new Set((opts.native?.categories ?? []).map(foldKey));
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
    page.sections.map((section) => {
      const withNative =
        opts.native && nativeKeys.has(foldKey(section.key))
          ? [opts.native, ...section.items]
          : section.items;
      return {
        key: section.key,
        label: opts.title(section.label),
        total: section.total,
        items: withNative.slice(0, opts.cardCount),
      };
    }),
  );
}
