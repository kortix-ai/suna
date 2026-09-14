'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

import { localizeUiCatalog } from './localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from './remaining-ui-translation-keys.generated';

export function useLocalizedUiCatalog<T>(value: T): T {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return useMemo(
    () => localizeUiCatalog(value, tI18nComplete, REMAINING_UI_TRANSLATION_KEYS),
    [tI18nComplete, value],
  );
}
