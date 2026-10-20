'use client';

import {
  SessionIdsProvider,
  UiProvider,
  lazyClient,
  setUiHostEnv,
  setUiTelemetry,
  type UiHostComponents,
  type UiHostConfig,
  type UiLinkProps,
  type UiNavigation,
  type UiStringsInput,
  type UiViewer,
} from '@kortix/ui';
import type { UiI18nHost } from '@kortix/ui/i18n';
import { setSilentErrorToastFilter } from '@kortix/ui/toast';
import * as Sentry from '@sentry/nextjs';
import NextImage from 'next/image';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { forwardRef, useMemo, type ReactNode } from 'react';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useBranding } from '@kortix/ui/internal/branding/branding-provider';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { updateProfileMetadata } from '@/lib/auth/update-profile';
import { isRuntimeNotReadyNoiseMessage } from '@kortix/ui/internal/lib/browser-error-noise';
import { isConnectorsEnabled, isManagedProviderEnabled } from '@/lib/config';
import { isStaticSitePath } from '@/lib/navigation/static-site-path';
import { getEnv } from '@/lib/env-config';
import { isSilentTimeoutMessage } from '@kortix/ui/internal/lib/timeout-toast-policy';
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
    appUrl: env.APP_URL,
    // Build-time values: Next inlines NEXT_PUBLIC_* into the client bundle.
    mapStyleUrl: process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL,
    mapStyleUrlDark: process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK,
  };
});

/**
 * next/link, except a static, non-App-Router path (`/docs`, `/sitemap.xml`):
 * that one is a plain <a>, the `SiteLink` rule. Next cannot prefetch or
 * soft-navigate a static file.
 */
const HostLink = forwardRef<HTMLAnchorElement, Omit<UiLinkProps, 'ref'>>(function HostLink(
  props,
  ref,
) {
  if (isStaticSitePath(props.href)) {
    const { prefetch: _prefetch, ...anchor } = props;
    return <a ref={ref} {...anchor} />;
  }
  return <NextLink ref={ref} {...props} />;
});

const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };
const i18n: UiI18nHost = { useTranslations, useLocale };
const useViewerId = () => useAuth().user?.id;
function useViewer(): UiViewer | undefined {
  const { user } = useAuth();
  return useMemo(
    () => (user ? { id: user.id, email: user.email, metadata: user.user_metadata } : undefined),
    [user],
  );
}

// App features the session UI renders whole. Dialogs load lazily, so the
// root bundle stays small. The wallpaper is static: it paints on first frame.
const components: UiHostComponents = {
  Wallpaper: WallpaperBackground,
  // The project home's announcement: the Kortix mobile app.
  HomeAnnouncement: lazyClient(() =>
    import('@kortix/ui/workspace/home/mobile-app-promo').then((m) => m.MobileAppPromo),
  ),
  // Only the `codex` pooled provider exists today; the dialog ignores `providerId`.
  ProviderAccountsModal: lazyClient(() =>
    import('@/features/providers/chatgpt-accounts-dialog').then((m) => m.ChatGptAccountsDialog),
  ),
  ConnectorConnectModal: lazyClient(() =>
    import('@/components/setup-links/connector-connect-modal').then((m) => m.ConnectorConnectModal),
  ),
  ShareSessionModal: lazyClient(() =>
    import('@kortix/ui/workspace/sidebar/modal/share-session-modal').then(
      (m) => m.ShareSessionModal,
    ),
  ),
  // The whole Customize → Models surface: loaded on first open only.
  ProjectProviderModal: lazyClient(() =>
    import('@kortix/ui/customize/sections/llm-provider/llm-provider-modal').then(
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
  const config = useMemo<Partial<UiHostConfig>>(
    () => ({
      connectorsEnabled: isConnectorsEnabled(),
      managedModelsEnabled: isManagedProviderEnabled(),
      deploymentVersion: getEnv().VERSION,
    }),
    [],
  );
  return (
    <UiProvider
      strings={strings}
      link={HostLink}
      image={NextImage}
      useBrand={useBranding}
      navigation={navigation}
      i18n={i18n}
      useViewerId={useViewerId}
      useViewer={useViewer}
      updateViewerMetadata={updateProfileMetadata}
      config={config}
      components={components}
    >
      <RouteSessionIds>{children}</RouteSessionIds>
    </UiProvider>
  );
}
