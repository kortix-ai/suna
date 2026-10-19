'use client';

import { UiProvider, type UiNavigation, type UiStringsInput } from '@kortix/ui';
import type { UiI18nHost } from '@kortix/ui/i18n';
import { SessionIdsProvider } from '@kortix/ui/providers/session-ids';
import { setUiTelemetry } from '@kortix/ui/lib/telemetry';
import { setSilentErrorToastFilter } from '@kortix/ui/toast';
import * as Sentry from '@sentry/nextjs';
import NextImage from 'next/image';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';

import { useBranding } from '@/features/branding/branding-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { isRuntimeNotReadyNoiseMessage } from '@/lib/browser-error-noise';
import { isBillingEnabled } from '@/lib/config';
import { isSilentTimeoutMessage } from '@/lib/timeout-toast-policy';
import { track, type PanelEvent } from '@/lib/track';

// Request-deadline noise never reaches a toast. Set at module load, before the first errorToast.
setSilentErrorToastFilter(isSilentTimeoutMessage);

// Package telemetry goes to posthog (`lib/track`) and Sentry. A transient
// "runtime not ready" crash is an expected state, never a Sentry event.
// `track` accepts only PanelEvent names: a misspelled event fails tsc.
declare module '@kortix/ui/lib/telemetry' {
  interface UiTelemetryRegister {
    event: PanelEvent;
  }
}

setUiTelemetry({
  track,
  captureException: (error, context) => {
    if (isRuntimeNotReadyNoiseMessage((error as Error | null)?.message)) return;
    Sentry.captureException(error, context);
  },
  captureMessage: (message, context) => Sentry.captureMessage(message, context),
  addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
});

const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };
const i18n: UiI18nHost = { useTranslations, useLocale };
const useViewerId = () => useAuth().user?.id;

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

/** The session UI reads its ids from `/projects/[id]/sessions/[sessionId]`. */
function RouteSessionIds({ children }: { children: ReactNode }) {
  const params = useParams<{ id?: string; sessionId?: string }>();
  return (
    <SessionIdsProvider projectId={one(params?.id)} sessionId={one(params?.sessionId)}>
      {children}
    </SessionIdsProvider>
  );
}

/**
 * Feeds @kortix/ui the viewer's language, next/link, next/image, next/navigation, the
 * signed-in user and the organization branding. Mounted once, inside
 * I18nProvider and AuthProvider. KortixLogo calls `useBranding` where it
 * renders, so it reads BrandingProvider, which mounts lower down.
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
  // Read on first render, not at module load: the browser reads the runtime config script.
  const config = useMemo(() => ({ billingEnabled: isBillingEnabled() }), []);
  return (
    <UiProvider
      strings={strings}
      link={NextLink}
      image={NextImage}
      useBrand={useBranding}
      navigation={navigation}
      i18n={i18n}
      useViewerId={useViewerId}
      config={config}
    >
      <RouteSessionIds>{children}</RouteSessionIds>
    </UiProvider>
  );
}
