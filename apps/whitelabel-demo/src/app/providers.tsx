'use client';

import { lazyClient, UiProvider, type UiHostComponents, type UiNavigation } from '@kortix/ui';
import { IconProvider } from '@kortix/ui/icon-provider';
import Loading from '@kortix/ui/loading';
import { TooltipProvider } from '@kortix/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';

// Importing the client configures the SDK platform seam once (createKortix),
// defaulting to direct mode. `configureWrapperMode` re-points it below when
// wrapper mode is confirmed.
import { configureWrapperMode } from '@/lib/kortix';
import { fetchWrapperMode } from '@/lib/mode';
import { resolveWrapperPreviewUrl } from '@/lib/preview-url';
// The toast host. @kortix/ui/toast draws every toast (successToast,
// errorToast, …) into the <Toaster /> it exports, so the host needs no sonner
// dependency of its own.
import { Toaster } from '@kortix/ui/toast';

const WrapperModeContext = createContext(false);

// Client-side navigation for @kortix/ui (useUiRouter().push), not full page loads.
const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };

// A Kortix deployment serves its managed model lineup; without this flag the
// model picker would list only the account's own provider keys.
const config = { managedModelsEnabled: true };
// Wrapper mode proxies HTTP through Next route handlers, which cannot upgrade
// the terminal's WebSocket, so the Terminal control is hidden there.
const wrapperConfig = { ...config, terminalEnabled: false };

// The app features the session UI renders whole. A slot left out hides its
// control. Lumen ships Kortix's own sharing dialog (who can open a session,
// public links), loaded on first open.
const components: UiHostComponents = {
  ShareSessionModal: lazyClient(() => import('@kortix/ui/workspace').then((m) => m.ShareSessionModal)),
};

/**
 * True when this server has `KORTIX_API_KEY` set — Lumen is running as a BFF
 * in front of Kortix rather than a pure client of it. Drives which auth gate
 * renders (`LoginGate` vs `ApiKeyGate`) and how the preview iframe
 * authenticates.
 */
export function useWrapperMode(): boolean {
  return useContext(WrapperModeContext);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Flawless freshness: revalidate on focus/reconnect, short stale window.
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );

  // `null` = still resolving. Block rendering (and therefore every data
  // fetch a page might fire) until the mode is known — otherwise the first
  // paint in wrapper mode could fire a request against the direct-mode
  // default before `configureWrapperMode()` runs. In direct mode this adds
  // one same-origin round trip before first paint (`GET /api/mode`); it's
  // the cost of a single source of truth for which mode is active.
  const [wrapperMode, setWrapperMode] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWrapperMode().then((isWrapper) => {
      if (cancelled) return;
      if (isWrapper) configureWrapperMode();
      setWrapperMode(isWrapper);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (wrapperMode === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <WrapperModeContext.Provider value={wrapperMode}>
      <QueryClientProvider client={queryClient}>
        {/* @kortix/ui's host adapters: links and router calls navigate with
            next/link and next/navigation; copy keeps the English defaults; images
            stay plain <img> (next/image would need images.remotePatterns for
            organization logos). IconProvider gives every Phosphor icon the house
            weight. Mounted once. */}
        <UiProvider link={NextLink} navigation={navigation} components={components} config={wrapperMode ? wrapperConfig : config}
          resolvePreviewUrl={wrapperMode ? resolveWrapperPreviewUrl : undefined}>
          <IconProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster />
          </IconProvider>
        </UiProvider>
      </QueryClientProvider>
    </WrapperModeContext.Provider>
  );
}
