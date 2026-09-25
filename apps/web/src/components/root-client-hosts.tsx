'use client';

/**
 * Global client hosts mounted once by the root layout.
 *
 * Each host renders nothing on first paint: it either waits for a store, a
 * query, or a user event, or it only runs effects. So each one is a
 * `next/dynamic({ ssr: false })` chunk that loads after hydration instead of a
 * part of the root layout's entry JS. `React.lazy()` in the server layout did
 * not split these: every client reference still shipped in the layout entry.
 */

// Not dynamic itself: one store subscription that loads the heavy modal body
// on the first open (see app-file-preview-host.tsx).
import { AppFilePreviewHost } from '@/components/app-file-preview-host';
import { isDesktop } from '@/lib/desktop';
import dynamic from 'next/dynamic';
import { useSyncExternalStore } from 'react';

const Analytics = dynamic(() => import('@vercel/analytics/react').then((mod) => mod.Analytics), {
  ssr: false,
});
const SpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((mod) => mod.SpeedInsights),
  { ssr: false },
);
const PostHogIdentify = dynamic(
  () => import('@/components/posthog-identify').then((mod) => mod.PostHogIdentify),
  { ssr: false },
);
const RouteChangeTracker = dynamic(
  () => import('@/components/analytics/route-change-tracker').then((mod) => mod.RouteChangeTracker),
  { ssr: false },
);
const AuthEventTracker = dynamic(
  () => import('@/components/analytics/auth-event-tracker').then((mod) => mod.AuthEventTracker),
  { ssr: false },
);
const LocalhostLinkInterceptor = dynamic(
  () =>
    import('@/components/localhost-link-interceptor').then((mod) => mod.LocalhostLinkInterceptor),
  { ssr: false },
);
const DesktopUrlPrompt = dynamic(
  () => import('@/components/desktop/desktop-url-prompt').then((mod) => mod.DesktopUrlPrompt),
  { ssr: false },
);
const MaintenanceBannerHost = dynamic(
  () =>
    import('@/components/announcements/maintenance-banner-host').then(
      (mod) => mod.MaintenanceBannerHost,
    ),
  { ssr: false },
);
const ImpersonationBanner = dynamic(
  () =>
    import('@/components/impersonation/impersonation-banner').then(
      (mod) => mod.ImpersonationBanner,
    ),
  { ssr: false },
);

const noopSubscribe = () => () => {};

/** True only in the desktop shell's webview. False on the server and on web. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(noopSubscribe, isDesktop, () => false);
}

/**
 * Hosts that need no provider beyond I18n/Auth. `vercel` comes from the server
 * (`process.env.VERCEL` is not inlined into client bundles).
 */
export function RootClientHosts({ vercel }: { vercel: boolean }) {
  const desktop = useIsDesktop();
  return (
    <>
      {desktop ? <DesktopUrlPrompt /> : null}
      {vercel ? <Analytics /> : null}
      {vercel ? <SpeedInsights /> : null}
      <PostHogIdentify />
      <RouteChangeTracker />
      <AuthEventTracker />
      <LocalhostLinkInterceptor />
    </>
  );
}

/** Hosts that read React Query — mount inside `ReactQueryProvider`. */
export function RootQueryHosts() {
  return (
    <>
      {/* Global maintenance/incident banner (info/warning/critical). */}
      <MaintenanceBannerHost />
      {/* Fallback file-preview modal for surfaces with no session side panel
          (dashboard, project pages). */}
      <AppFilePreviewHost />
      {/* Act-as banner. Mounted at the ROOT, not under (app): a platform admin
          acting as a customer carries the grant on every request from this
          tab, including the admin console and account settings, so the
          banner has to be true everywhere too. Renders nothing when no grant
          is held. */}
      <ImpersonationBanner />
    </>
  );
}
