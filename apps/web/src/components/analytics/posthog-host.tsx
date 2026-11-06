'use client';

/**
 * Starts PostHog on every page once the browser is idle, links the visitor to
 * the signed-in user, and re-applies the per-page masking rule on
 * each navigation. Renders nothing. See lib/analytics/posthog-client.ts.
 */

import { startPostHog, syncPostHogPage } from '@/lib/analytics/posthog-client';
import { createClient } from '@/lib/supabase/client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

type PostHog = NonNullable<Awaited<ReturnType<typeof startPostHog>>>;

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

export function PostHogHost() {
  const pathname = usePathname();
  const [posthog, setPosthog] = useState<PostHog | null>(null);

  // Start after hydration and the first paint, with the user the page loaded
  // with. getSession reads the local session; it makes no request.
  useEffect(() => {
    let cancelled = false;
    const cancelIdle = whenIdle(() => {
      void createClient()
        .auth.getSession()
        .then(({ data }) => data.session?.user.id ?? null)
        .catch(() => null)
        .then((userId) => startPostHog(userId))
        .then((client) => {
          if (!cancelled) setPosthog(client);
        });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, []);

  useEffect(() => {
    if (!posthog) return;
    const supabase = createClient();
    // Once per user and page load; token refreshes fire this listener hourly.
    let identified: string | null = null;
    const listener = supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user;
      if (user) {
        if (identified === user.id) return;
        identified = user.id;
        // The user id only: no email or name goes to PostHog (data minimization).
        posthog.identify(user.id, undefined, { signed_up_at: user.created_at });
      } else if (event === 'SIGNED_OUT') {
        identified = null;
        posthog.reset();
      }
    });
    return () => listener.data.subscription.unsubscribe();
  }, [posthog]);

  useEffect(() => {
    if (posthog) syncPostHogPage(posthog, pathname);
  }, [posthog, pathname]);

  return null;
}
