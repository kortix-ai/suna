'use client';

import { UiProvider, type UiStringsInput } from '@kortix/ui';
import { setSilentErrorToastFilter } from '@kortix/ui/toast';
import NextLink from 'next/link';
import { useMemo, type ReactNode } from 'react';

import { useBranding } from '@/features/branding/branding-provider';
import { useTranslations } from '@/i18n/use-translations';
import { isSilentTimeoutMessage } from '@/lib/timeout-toast-policy';

// Request-deadline noise never reaches a toast. Set at module load, before the first errorToast.
setSilentErrorToastFilter(isSilentTimeoutMessage);

/**
 * Feeds @kortix/ui the viewer's language, next/link and the organization
 * branding. Mounted once, inside I18nProvider. KortixLogo calls `useBranding`
 * where it renders, so it reads BrandingProvider, which mounts lower down.
 */
export function KortixUiProvider({ children }: { children: ReactNode }) {
  const common = useTranslations('common');
  const palette = useTranslations('commandPalette');
  // apps/web does not render @kortix/ui/chat, so `chat` keeps its English defaults.
  const strings = useMemo<UiStringsInput>(
    () => ({
      confirm: common('confirm'),
      cancel: common('cancel'),
      close: common('close'),
      commandPaletteTitle: palette('title'),
      commandPaletteDescription: palette('description'),
    }),
    [common, palette],
  );
  return (
    <UiProvider strings={strings} link={NextLink} useBrand={useBranding}>
      {children}
    </UiProvider>
  );
}
