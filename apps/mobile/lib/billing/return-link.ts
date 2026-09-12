/**
 * Deep-link contract for the web-checkout round-trip.
 *
 * Mobile has NO in-app payment — the upgrade opens the backend's masked
 * kortix.com checkout in an in-app browser, and the web redirects back to the
 * app via the `agentpress://` scheme. `WebBrowser.openAuthSessionAsync` closes
 * on that redirect; `parseBillingReturn` also lets the global deep-link handler
 * recognise a return if the link arrives out-of-band (e.g. universal link).
 */

export const APP_SCHEME = 'agentpress://';
const BILLING_PATH = 'billing';

/** Return URL the backend redirects to after a successful checkout. */
export function buildSuccessUrl(context: string = 'checkout'): string {
  return `${APP_SCHEME}${BILLING_PATH}/success?context=${context}`;
}

/** Return URL the backend redirects to when the user cancels checkout. */
export function buildCancelUrl(): string {
  return `${APP_SCHEME}${BILLING_PATH}/cancel`;
}

export type BillingReturn = {
  kind: 'success' | 'cancel' | null;
  /** e.g. 'plan' | 'credits' — only present on success. */
  context: string | null;
};

function getQueryParam(query: string, key: string): string | null {
  if (!query) return null;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    if (k === key) {
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/** Classify a deep link as a billing success/cancel return, or neither. */
export function parseBillingReturn(url: string): BillingReturn {
  const none: BillingReturn = { kind: null, context: null };
  if (!url || !url.startsWith(APP_SCHEME)) return none;

  const rest = url.slice(APP_SCHEME.length); // "billing/success?context=plan"
  const qIndex = rest.indexOf('?');
  const path = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  if (path === `${BILLING_PATH}/success`) {
    return { kind: 'success', context: getQueryParam(query, 'context') };
  }
  if (path === `${BILLING_PATH}/cancel`) {
    return { kind: 'cancel', context: null };
  }
  return none;
}
