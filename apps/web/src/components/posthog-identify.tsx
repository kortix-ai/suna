'use client';

import { createClient } from '@/lib/supabase/client';
import posthog from 'posthog-js';
import { useEffect } from 'react';

export const PostHogIdentify = () => {
  useEffect(() => {
    const supabase = createClient();
    const listener = supabase.auth.onAuthStateChange((_, session) => {
      if (session) {
        posthog.identify(session.user.id, { email: session.user.email });
      } else {
        posthog.reset();
      }
    });

    return () => {
      listener.data.subscription.unsubscribe();
    };
  }, []);

  return null;
};
