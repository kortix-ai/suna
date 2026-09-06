'use client';

import posthog from 'posthog-js';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Person + group identity for PostHog. Stable auth id only — never email or a
 * display name (the no-PII rule in lib/track.ts). `account` and `project`
 * groups mirror the two units the product is priced and organised by; the
 * project id is the same route segment KortixProjectScope reads.
 */
export const PostHogIdentify = () => {
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const params = useParams();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  useEffect(() => {
    const supabase = createClient();
    const listener = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        posthog.identify(session.user.id);
      } else if (event === 'SIGNED_OUT') {
        // Only a real sign-out. INITIAL_SESSION with no session fires on every
        // anonymous page load, and a reset there mints a new anonymous id each time.
        posthog.reset();
      }
    });

    return () => {
      listener.data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (accountId) posthog.group('account', accountId);
  }, [accountId]);

  useEffect(() => {
    if (projectId) posthog.group('project', projectId);
  }, [projectId]);

  return null;
};
