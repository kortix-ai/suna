'use client';

import { useTranslations } from '@/i18n/use-translations';
import { getLocalizedOsContent } from './content';

/** The AI OS copy in the reader's locale. */
export function useOsContent() {
  return getLocalizedOsContent(useTranslations('hardcodedUi.i18nComplete'));
}
