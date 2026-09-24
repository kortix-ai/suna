'use client';

import { isPostHogLoaded, loadPostHog } from '@/lib/posthog-lazy';
import { createClient } from '@/lib/supabase/client';
import { useEffect } from 'react';

export const PostHogIdentify = () => {
  useEffect(() => {
    const supabase = createClient();
    const listener = supabase.auth.onAuthStateChange((_, session) => {
      if (session) {
        void loadPostHog().then((posthog) =>
          posthog.identify(session.user.id, { email: session.user.email }),
        );
      } else if (isPostHogLoaded()) {
        // A signed-out visitor never loads posthog-js; there is nothing to
        // reset unless this page identified someone.
        void loadPostHog().then((posthog) => posthog.reset());
      }
    });

    return () => {
      listener.data.subscription.unsubscribe();
    };
  }, []);

  return null;
};
