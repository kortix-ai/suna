'use client';

import { useMemo } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { localizedDevelopersCopy } from './content';

/** The `/developers` copy in the visitor's language, for the client sections. */
export function useDevelopersCopy() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return useMemo(() => localizedDevelopersCopy(tI18nComplete), [tI18nComplete]);
}
