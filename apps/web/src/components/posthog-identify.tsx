'use client';

import posthog from 'posthog-js';
import { useParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  consentFromUpdate,
  parseCookieYesAnalytics,
  shouldCapture,
  type AnalyticsConsent,
} from '@/lib/analytics/posthog-consent';
import { createClient } from '@/lib/supabase/client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Consent + identity for PostHog.
 *
 * Capture is allowed by the rule in lib/analytics/posthog-consent.ts
 * (CookieYes "analytics" consent for visitors, an explicit rejection wins
 * everywhere, signed-in users otherwise). instrumentation-client.ts applies
 * that rule at init from the cookies; this component re-applies it when the
 * CookieYes banner is answered (`cookieyes_consent_update`) and when the auth
 * state changes, then identifies with the stable auth id only — never email or
 * a display name (the no-PII rule in lib/track.ts). `account` and `project`
 * groups mirror the two units the product is priced and organised by.
 */
export const PostHogIdentify = () => {
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const params = useParams();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const signedInRef = useRef(false);
  const consentRef = useRef<AnalyticsConsent>(null);

  useEffect(() => {
    consentRef.current = parseCookieYesAnalytics(document.cookie);

    const apply = () => {
      const allowed = shouldCapture({ signedIn: signedInRef.current, consent: consentRef.current });
      if (allowed && posthog.has_opted_out_capturing()) {
        posthog.opt_in_capturing({ captureEventName: null });
      } else if (!allowed && !posthog.has_opted_out_capturing()) {
        posthog.opt_out_capturing();
      }
    };

    const onConsentUpdate = (event: Event) => {
      const next = consentFromUpdate((event as CustomEvent).detail) ?? parseCookieYesAnalytics(document.cookie);
      consentRef.current = next;
      apply();
    };
    document.addEventListener('cookieyes_consent_update', onConsentUpdate);

    const supabase = createClient();
    const listener = supabase.auth.onAuthStateChange((event, session) => {
      signedInRef.current = Boolean(session);
      if (session) {
        apply(); // opt in before identify, or the identify is dropped
        posthog.identify(session.user.id);
      } else if (event === 'SIGNED_OUT') {
        // Only a real sign-out. INITIAL_SESSION with no session fires on every
        // anonymous page load, and a reset there mints a new anonymous id each time.
        posthog.reset();
        apply();
      } else {
        apply();
      }
    });

    return () => {
      document.removeEventListener('cookieyes_consent_update', onConsentUpdate);
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
