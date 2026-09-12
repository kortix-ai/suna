import { sectionTitle } from '@kortix/shared/connector-sections';

import { translateUiCatalogText } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

// The category rules live in `@kortix/shared` so the API groups the complete
// catalogue with exactly the rules this app renders with.
export {
  OTHER,
  POPULAR_SECTION,
  CURATED_SECTIONS,
  sectionKeyForCategory,
  sectionTitle,
  sectionKeysForEntry,
  countInSection,
  groupIntoSections,
  humanizeCategory,
} from '@kortix/shared/connector-sections';
export type { CatalogSectionDef } from '@kortix/shared/connector-sections';

/**
 * Two rows of the widest grid (`xl:grid-cols-3`). The live catalogue makes
 * this load-bearing rather than theoretical: one page of
 * `listDiscoverConnectors` puts 26 of its 48 items under `productivity`
 * alone, so a category section renders its first 6 and defers the rest to
 * "View all".
 */
export const CATEGORY_ROW_CAP = 6;

/**
 * The category `Select`'s "no category" value. Radix `SelectItem` cannot hold
 * an empty string, so this needs a sentinel no real category can collide with.
 * `groupIntoSections` trims every key and every curated key is
 * lowercase-kebab, so a leading space is unreachable by construction — this is
 * provably distinct rather than merely unlikely.
 */
export const ALL_CATEGORIES = ' all';

export function localizedSectionTitle(key: string, tI18nComplete: UiTranslator): string {
  return translateUiCatalogText(sectionTitle(key), tI18nComplete, REMAINING_UI_TRANSLATION_KEYS);
}
