/**
 * The one PostHog client in the web app. `PostHogHost` starts it once per page
 * with the signed-in user (or none); every other caller (`lib/track`) awaits
 * `getPostHog()`, which resolves after that start. On a host with no project
 * (`posthogProjectForHost`) it resolves to null and the library is never
 * fetched.
 *
 * No remote code. The `no-external` build never injects a script from
 * PostHog: not the remote-config `config.js`, not site apps. The two
 * extensions we use, surveys and the session recorder, ship in our own
 * bundle. Whoever administers the PostHog project cannot run code on
 * kortix.com (GTM stays off signed-in pages for the same reason).
 *
 * Consent decides storage, not collection. Until the CookieYes banner grants
 * analytics, ids live in memory only: nothing in cookies or local storage.
 * - An anonymous visitor then gets a new id on every full page load.
 * - A signed-in user starts with their own user id (`bootstrap`), so there is
 *   no anonymous id to merge on each page load.
 * A grant moves the client to `localStorage+cookie`, which is what links an ad
 * click on a landing page to the sign-up minutes later.
 *
 * Replays record only with consent, only outside the desktop app, and only on
 * public pages (`isReplayAllowedPath`). Inputs are always masked. Autocapture
 * keeps element text on public pages and masks it on private ones; the
 * `before_send` scrubber removes what masking does not cover.
 */

import { isDesktop } from '@kortix/ui/internal/lib/desktop';

import {
  type AnalyticsConsent,
  isPrivatePath,
  isReplayAllowedPath,
  POSTHOG_API_HOST,
  POSTHOG_UI_HOST,
  posthogProjectForHost,
  readAnalyticsConsent,
  scrubEvent,
} from './posthog-config';

type PostHog = (typeof import('posthog-js/dist/module.no-external'))['default'];

let resolveClient: (client: PostHog | null) => void = () => {};
const clientReady = new Promise<PostHog | null>((resolve) => {
  resolveClient = resolve;
});
let started = false;
let consent: AnalyticsConsent = 'unknown';
let recorderLoaded: Promise<unknown> | null = null;

/** The client once `startPostHog` ran, or null on hosts that do not report. */
export function getPostHog(): Promise<PostHog | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return clientReady;
}

/** Initialize once. `userId`: the signed-in Supabase user at page load, if any. */
export function startPostHog(userId: string | null): Promise<PostHog | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!started) {
    started = true;
    void start(userId)
      .catch(() => null)
      .then(resolveClient);
  }
  return clientReady;
}

function persistenceFor(value: AnalyticsConsent) {
  return value === 'granted' ? ('localStorage+cookie' as const) : ('memory' as const);
}

async function start(userId: string | null): Promise<PostHog | null> {
  const project = posthogProjectForHost(
    window.location.hostname,
    process.env.NEXT_PUBLIC_POSTHOG_KEY,
  );
  if (!project) return null;

  const [{ default: posthog }] = await Promise.all([
    import('posthog-js/dist/module.no-external'),
    // Registers itself on window.__PosthogExtensions__ before init reads it.
    import('posthog-js/dist/surveys'),
  ]);
  consent = readAnalyticsConsent(document.cookie);
  const privatePage = isPrivatePath(window.location.pathname);
  const origin = window.location.origin;

  posthog.init(project.key, {
    api_host: POSTHOG_API_HOST,
    ui_host: POSTHOG_UI_HOST,
    defaults: '2026-08-30',
    person_profiles: 'identified_only',
    persistence: persistenceFor(consent),
    ...(consent !== 'granted' && userId
      ? { bootstrap: { distinctID: userId, isIdentifiedID: true } }
      : {}),
    // kortix.com, dev. and staging. are separate audiences: one cookie on
    // .kortix.com would merge a developer's dev and prod visits.
    cross_subdomain_cookie: false,
    secure_cookie: window.location.protocol === 'https:',
    capture_pageview: 'history_change',
    capture_pageleave: 'if_capture_pageview',
    autocapture: true,
    mask_all_text: privatePage,
    mask_all_element_attributes: privatePage,
    // Sentry owns errors; Vercel Speed Insights owns web vitals.
    capture_exceptions: false,
    capture_performance: false,
    // Replays start per page in syncPostHogPage, never by default.
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      recordHeaders: false,
      recordBody: false,
    },
    // Kortix hosts drop bot traffic. A local run keeps it, tagged
    // `$browser_type: bot`, so a scripted browser can verify events.
    opt_out_useragent_filter: project.environment === 'local',
    disable_external_dependency_loading: true,
    opt_in_site_apps: false,
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
    before_send: (event) => (event ? scrubEvent(event, origin) : event),
    // Runs inside init, before the first event, so every event carries these.
    loaded: (client) =>
      client.register({
        environment: project.environment,
        platform: isDesktop() ? 'desktop' : 'web',
        app_version: process.env.NEXT_PUBLIC_KORTIX_VERSION || 'unknown',
      }),
  });

  document.addEventListener('cookieyes_consent_update', () => {
    const next = readAnalyticsConsent(document.cookie);
    if (next === consent) return;
    consent = next;
    posthog.set_config({ persistence: persistenceFor(next) });
    syncPostHogPage(posthog, window.location.pathname);
  });

  syncPostHogPage(posthog, window.location.pathname);
  return posthog;
}

/**
 * Apply the per-page rules after a navigation: text masking for autocapture,
 * and whether a replay may record here.
 */
export function syncPostHogPage(posthog: PostHog, pathname: string): void {
  const privatePage = isPrivatePath(pathname);
  posthog.set_config({ mask_all_text: privatePage, mask_all_element_attributes: privatePage });

  const mayRecord = consent === 'granted' && !isDesktop() && isReplayAllowedPath(pathname);
  if (!mayRecord) {
    if (posthog.sessionRecordingStarted()) posthog.stopSessionRecording();
    return;
  }
  recorderLoaded ??= import('posthog-js/dist/recorder');
  void recorderLoaded.then(() => {
    // The visitor may have navigated to a private page while it loaded.
    if (!isReplayAllowedPath(window.location.pathname)) return;
    if (!posthog.sessionRecordingStarted()) posthog.startSessionRecording();
  });
}
