'use client';

import { useLocale } from '@/i18n/use-translations';

/**
 * A heading's muted second line that has no catalog key yet renders in
 * English only. Other locales show the translated first line alone, so a
 * heading never mixes two languages. Remove a call once the line has a key.
 */
export function useEnglishOnly(): (text: string) => string | undefined {
  const locale = useLocale();
  return (text) => (locale === 'en' ? text : undefined);
}
