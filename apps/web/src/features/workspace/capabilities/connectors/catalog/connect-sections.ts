import type {
  ConnectSectionsPage,
  ConnectToolkit,
  PipedreamApp,
  PipedreamCategory,
} from '@kortix/sdk';

import { catalogEntryFromEasyConnect, foldKey, type CatalogEntry } from './catalog-entry';
import type { CatalogSection } from './use-catalog';

export type EasyConnectApp = PipedreamApp & { provider?: 'composio' | 'pipedream' };

/** The browse page in one shape for both Easy Connect providers. */
export interface EasyConnectSectionsPage {
  sections: Array<{ key: string; label: string; total: number; apps: EasyConnectApp[] }>;
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
 * Normalise the Composio browse page to the Pipedream sections shape.
 *
 * Labels are replaced by keys. Composio's category names are lowercase
 * ("server monitoring"), and the paged grid titles a category by humanizing its
 * key — so titling by key keeps a section heading and the header of the
 * category it opens spelling the same name.
 */
export function sectionsPageFromConnect(page: ConnectSectionsPage): EasyConnectSectionsPage {
  return {
    sections: page.sections.map((section) => ({
      key: section.key,
      label: section.key,
      total: section.total,
      apps: section.toolkits.map(connectToolkitApp),
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
 * reading the length is the bug that labelled every Composio category `· 1`.
 *
 * `native` is the Computers card. No catalogue publishes it, and the browse
 * page is where it is discovered, so it leads the section for the category it
 * claims. It does not change that section's `total`, which counts the
 * catalogue the heading's "View all" opens.
 */
export function browseSections(
  page: EasyConnectSectionsPage,
  opts: {
    native: CatalogEntry | null;
    cardCount: number;
    title: (label: string) => string;
  },
): CatalogSection[] {
  const nativeKeys = new Set((opts.native?.categories ?? []).map(foldKey));
  return page.sections.map((section) => {
    const items = section.apps.map(catalogEntryFromEasyConnect);
    const withNative =
      opts.native && nativeKeys.has(foldKey(section.key)) ? [opts.native, ...items] : items;
    return {
      key: section.key,
      label: opts.title(section.label),
      total: section.total,
      items: withNative.slice(0, opts.cardCount),
    };
  });
}
