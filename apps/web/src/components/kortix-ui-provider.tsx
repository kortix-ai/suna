'use client';

import { UiProvider, type UiNavigation, type UiStringsInput } from '@kortix/ui';
import { lazyClient } from '@kortix/ui/lib/lazy-client';
import type { UiHostComponents } from '@kortix/ui/providers/ui-provider';
import type { UiI18nHost } from '@kortix/ui/i18n';
import { SessionIdsProvider } from '@kortix/ui/providers/session-ids';
import { setUiHostEnv } from '@kortix/ui/lib/host-env';
import { setUiTelemetry } from '@kortix/ui/lib/telemetry';
import { setSilentErrorToastFilter } from '@kortix/ui/toast';
import * as Sentry from '@sentry/nextjs';
import NextImage from 'next/image';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useBranding } from '@/features/branding/branding-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { isRuntimeNotReadyNoiseMessage } from '@/lib/browser-error-noise';
import { isBillingEnabled } from '@/lib/config';
import { getEnv } from '@/lib/env-config';
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

// The reader runs per call: the browser reads the runtime config script after module load.
setUiHostEnv(() => {
  const env = getEnv();
  return {
    billingEnabled: env.BILLING_ENABLED,
    appUrl: env.APP_URL,
    backendUrl: env.BACKEND_URL,
    // Build-time values: Next inlines NEXT_PUBLIC_* into the client bundle.
    mapStyleUrl: process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL,
    mapStyleUrlDark: process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK,
  };
});

const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };
const i18n: UiI18nHost = { useTranslations, useLocale };
const useViewerId = () => useAuth().user?.id;

// App features the session UI renders whole. Dialogs load lazily, so the
// root bundle stays small. The wallpaper is static: it paints on first frame.
const components: UiHostComponents = {
  Wallpaper: WallpaperBackground,
  ChatGptAccountsDialog: lazyClient(() =>
    import('@/features/providers/chatgpt-accounts-dialog').then((m) => m.ChatGptAccountsDialog),
  ),
  ConnectorConnectModal: lazyClient(() =>
    import('@/components/setup-links/connector-connect-modal').then((m) => m.ConnectorConnectModal),
  ),
  ShareSessionModal: lazyClient(() =>
    import('@/features/workspace/project-sidebar/modal/share-session-modal').then(
      (m) => m.ShareSessionModal,
    ),
  ),
  // The whole Customize → Models surface: loaded on first open only.
  ProjectProviderModal: lazyClient(() =>
    import('@/features/workspace/customize/sections/llm-provider/llm-provider-modal').then(
      (m) => m.ProjectProviderModal,
    ),
  ),
};

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
      components={components}
    >
      <RouteSessionIds>{children}</RouteSessionIds>
    </UiProvider>
  );
}
