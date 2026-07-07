'use client';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';

// Importing the client configures the SDK platform seam once (createKortix),
// defaulting to direct mode. `configureWrapperMode` re-points it below when
// wrapper mode is confirmed.
import { configureWrapperMode } from '@/lib/kortix';
import { fetchWrapperMode } from '@/lib/mode';

const WrapperModeContext = createContext(false);

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
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <WrapperModeContext.Provider value={wrapperMode}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </QueryClientProvider>
    </WrapperModeContext.Provider>
  );
}
