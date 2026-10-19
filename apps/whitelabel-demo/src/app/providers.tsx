'use client';

import { UiProvider, type UiNavigation } from '@kortix/ui';
import { IconProvider } from '@kortix/ui/icon-provider';
import { TooltipProvider } from '@kortix/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';
import { type AuthClient, ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { ConvexReactClient } from 'convex/react';
// The toast host. @kortix/ui/toast draws every toast (successToast,
// errorToast, …) into the <Toaster /> it exports, so the host needs no sonner
// dependency of its own.
import { Toaster } from '@kortix/ui/toast';

// Client-side navigation for @kortix/ui (useUiRouter().push), not full page loads.
const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };

// Lumen's own backend: orgs, workspaces, threads. Better Auth runs inside it.
// The fallback is the `convex dev` local default, so a build without env still compiles.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL || 'http://127.0.0.1:3210');

// @convex-dev/better-auth@0.12.5 types its prop for a client without extra
// plugins; the organization plugin's session type does not unify with it.
// The runtime object is the same client.
const providerAuthClient = authClient as unknown as AuthClient;

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

  return (
    <ConvexBetterAuthProvider client={convex} authClient={providerAuthClient}>
      <QueryClientProvider client={queryClient}>
        {/* @kortix/ui's host adapters: links and router calls navigate with
            next/link and next/navigation; copy keeps the English defaults; images
            stay plain <img> (next/image would need images.remotePatterns for
            organization logos). IconProvider gives every Phosphor icon the house
            weight. Mounted once. */}
        <UiProvider link={NextLink} navigation={navigation}>
          <IconProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster />
          </IconProvider>
        </UiProvider>
      </QueryClientProvider>
    </ConvexBetterAuthProvider>
  );
}
