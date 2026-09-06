/**
 * Whether PostHog may capture for this browser. Pure functions over the
 * cookie header, so `instrumentation-client.ts` can decide synchronously at
 * init (no lost first pageview) and `posthog-identify.tsx` can re-decide on
 * every consent or auth change.
 *
 * Inputs:
 *  - CookieYes, the marketing-site banner GTM injects. Its `cookieyes-consent`
 *    cookie carries `analytics:yes|no` and `action:yes` once the visitor
 *    answered the banner. In an opt-in region the default before any answer is
 *    `analytics:no` with `action:no`; in an implied-consent region CookieYes
 *    writes `analytics:yes` without an action.
 *  - The Kortix session cookie (`sb-kortix-auth-token[-<port>][.<chunk>]`):
 *    present means a signed-in user.
 *
 * Rule:
 *  - an explicit "no" wins everywhere, signed in or not;
 *  - an explicit or implied "yes" allows capture;
 *  - with no decision recorded, only signed-in users are captured (first-party
 *    product analytics under legitimate interest, disclosed in the privacy
 *    policy; the banner is hidden inside the app, so most users never answer).
 */
export type AnalyticsConsent = 'yes' | 'no' | null;

export function parseCookieYesAnalytics(cookieHeader: string): AnalyticsConsent {
  const match = /(?:^|;\s*)cookieyes-consent=([^;]*)/.exec(cookieHeader);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const analytics = /(?:^|,)analytics:(yes|no)(?:,|$)/.exec(value)?.[1] as 'yes' | 'no' | undefined;
  if (!analytics) return null;
  const answered = /(?:^|,)action:yes(?:,|$)/.test(value);
  if (answered) return analytics;
  return analytics === 'yes' ? 'yes' : null; // implied consent counts; a default "no" is no decision
}

/** Consent carried by a `cookieyes_consent_update` DOM event. */
export function consentFromUpdate(
  detail: { accepted?: unknown; rejected?: unknown } | null | undefined,
): AnalyticsConsent {
  const has = (list: unknown) => Array.isArray(list) && list.includes('analytics');
  if (has(detail?.accepted)) return 'yes';
  if (has(detail?.rejected)) return 'no';
  return null;
}

export function hasKortixSession(cookieHeader: string): boolean {
  return /(?:^|;\s*)sb-kortix-auth-token(?:-\d+)?(?:\.\d+)?=/.test(cookieHeader);
}

export function shouldCapture(input: { signedIn: boolean; consent: AnalyticsConsent }): boolean {
  if (input.consent === 'no') return false;
  if (input.consent === 'yes') return true;
  return input.signedIn;
}

/** The init-time decision, from the live document. */
export function captureAllowedNow(cookieHeader: string): boolean {
  return shouldCapture({
    signedIn: hasKortixSession(cookieHeader),
    consent: parseCookieYesAnalytics(cookieHeader),
  });
}
