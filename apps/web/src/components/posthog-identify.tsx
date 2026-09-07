'use client';

import posthog from 'posthog-js';
import { useParams, usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  consentFromUpdate,
  hasKortixSession,
  parseCookieYesAnalytics,
  shouldCapture,
  type AnalyticsConsent,
} from '@/lib/analytics/posthog-consent';
import { replayAllowedForPath } from '@/lib/analytics/posthog-replay';
import { createClient } from '@/lib/supabase/client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

interface AnalyticsState {
  /**
   * `null` until Supabase reports the auth state, which is asynchronous and
   * lands AFTER the first route effect. Falling back to `false` there would opt
   * the client out and drop the first pageview of every signed-in visit, so an
   * unknown state reads the session cookie — the same source
   * `instrumentation-client.ts` used to make the init-time decision.
   */
  signedIn: boolean | null;
  consent: AnalyticsConsent;
  pathname: string;
}

/**
 * The one place capture and replay are switched on or off.
 *
 * Capture follows the consent rule (lib/analytics/posthog-consent.ts). Replay
 * follows that AND the route rule (lib/analytics/posthog-replay.ts): the
 * recorder never runs on the workspace, public shares or the admin console.
 * Module-level so every effect below calls the same function with the current
 * state, instead of three copies drifting apart.
 */
function applyAnalyticsState(state: AnalyticsState): void {
  try {
    const signedIn = state.signedIn ?? hasKortixSession(document.cookie);
    const capture = shouldCapture({ signedIn, consent: state.consent });
    if (capture && posthog.has_opted_out_capturing()) {
      posthog.opt_in_capturing({ captureEventName: null });
    } else if (!capture && !posthog.has_opted_out_capturing()) {
      posthog.opt_out_capturing();
    }

    // Opt-in first: a recorder started while opted out sends nothing.
    const replay = capture && replayAllowedForPath(state.pathname);
    if (replay && !posthog.sessionRecordingStarted()) {
      // Guarded: calling start on an already-running recorder resets it, and a
      // recorder that keeps restarting never flushes a snapshot. Every later
      // apply (remote config, auth, route change) retries, so a first call that
      // lands too early self-heals.
      posthog.startSessionRecording();
    } else if (!replay && posthog.sessionRecordingStarted()) {
      posthog.stopSessionRecording();
    }
  } catch {
    // Telemetry must never take a page down with it.
  }
}

/**
 * Consent, replay scope and identity for PostHog.
 *
 * `instrumentation-client.ts` applies the consent rule synchronously at init
 * from the cookies, so the first pageview is not lost. This component re-applies
 * it when the CookieYes banner is answered (`cookieyes_consent_update`), when
 * the auth state changes, and on every route change, then identifies with the
 * stable auth id only — never email or a display name (the no-PII rule in
 * lib/track.ts). `account` and `project` groups mirror the two units the product
 * is priced and organised by.
 */
export const PostHogIdentify = () => {
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const params = useParams();
  const pathname = usePathname();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const stateRef = useRef<AnalyticsState>({ signedIn: null, consent: null, pathname: '' });

  useEffect(() => {
    stateRef.current.consent = parseCookieYesAnalytics(document.cookie);

    const onConsentUpdate = (event: Event) => {
      stateRef.current.consent =
        consentFromUpdate((event as CustomEvent).detail) ?? parseCookieYesAnalytics(document.cookie);
      applyAnalyticsState(stateRef.current);
    };
    document.addEventListener('cookieyes_consent_update', onConsentUpdate);

    // Remote config decides sampling and whether replay is enabled for the
    // project at all, and it arrives after mount. Re-apply once it lands so the
    // recorder starts even when the first attempt was too early.
    let stopFlagWatch: (() => void) | undefined;
    try {
      stopFlagWatch = posthog.onFeatureFlags(() => applyAnalyticsState(stateRef.current)) as
        | (() => void)
        | undefined;
    } catch {
      // Older builds return void; the route effect still applies.
    }

    const supabase = createClient();
    const listener = supabase.auth.onAuthStateChange((event, session) => {
      stateRef.current.signedIn = Boolean(session);
      if (session) {
        applyAnalyticsState(stateRef.current); // opt in before identify, or the identify is dropped
        posthog.identify(session.user.id);
      } else if (event === 'SIGNED_OUT') {
        // Only a real sign-out. INITIAL_SESSION with no session fires on every
        // anonymous page load, and a reset there mints a new anonymous id each time.
        posthog.reset();
        applyAnalyticsState(stateRef.current);
      } else {
        applyAnalyticsState(stateRef.current);
      }
    });

    return () => {
      document.removeEventListener('cookieyes_consent_update', onConsentUpdate);
      stopFlagWatch?.();
      listener.data.subscription.unsubscribe();
    };
  }, []);

  // Route changes decide replay: entering the workspace stops the recorder,
  // leaving it starts one again. Also covers the first render.
  useEffect(() => {
    stateRef.current.pathname = pathname ?? '';
    applyAnalyticsState(stateRef.current);
  }, [pathname]);

  useEffect(() => {
    if (accountId) posthog.group('account', accountId);
  }, [accountId]);

  useEffect(() => {
    if (projectId) posthog.group('project', projectId);
  }, [projectId]);

  return null;
};
