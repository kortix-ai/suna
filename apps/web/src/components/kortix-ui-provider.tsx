'use client';

import { UiProvider, type UiStrings } from '@kortix/ui';
import NextLink from 'next/link';
import { useMemo, type ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';

/** Feeds @kortix/ui the viewer's language and next/link. Mounted once, inside I18nProvider. */
export function KortixUiProvider({ children }: { children: ReactNode }) {
  const common = useTranslations('common');
  const palette = useTranslations('commandPalette');
  const strings = useMemo<UiStrings>(
    () => ({
      confirm: common('confirm'),
      cancel: common('cancel'),
      commandPaletteTitle: palette('title'),
      commandPaletteDescription: palette('description'),
    }),
    [common, palette],
  );
  return (
    <UiProvider strings={strings} link={NextLink}>
      {children}
    </UiProvider>
  );
}
