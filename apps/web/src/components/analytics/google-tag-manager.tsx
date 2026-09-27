'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';

import { isAnalyticsExcludedPath } from '@/lib/analytics/gtm';
import { isDesktop } from '@/lib/desktop';

/**
 * Google Tag Manager, loaded after the page is done: on `window.load`, then
 * the next idle period (`next/script` `lazyOnload`).
 *
 * `@next/third-parties`' `<GoogleTagManager>` hard-codes `afterInteractive`.
 * In the App Router that also emits `<link rel="preload" as="script">` for
 * gtm.js into the document head, so the 160 KB container downloaded at high
 * priority next to the LCP image, then executed — and fanned out to Ads,
 * Facebook, CookieYes and the rest — while the page was still hydrating.
 *
 * Nothing is dropped by waiting. `window.dataLayer` exists from the inline
 * head script in the root layout, so every event pushed before GTM arrives
 * (page context, `sendGTMEvent`, route changes, sign-up conversions) queues
 * and is processed in order when the container boots. Consent is unchanged:
 * CookieYes is itself a GTM tag, so the consent banner and every tag it gates
 * move together.
 *
 * Never loads inside the desktop app (its user agent carries
 * `DESKTOP_UA_TOKEN`); GTM carries visitor de-anonymization tags that have no
 * place in the authenticated native client.
 *
 * Never loads when the document opens on a signed-in or capability-token page
 * (`isAnalyticsExcludedPath`: /projects, /admin, /secret-intake, …). Scripts
 * GTM injects run with the page's privileges, and the Supabase session cookie
 * is readable from script. The decision is made once per document: a script
 * cannot be unloaded, so a visitor who opens a marketing page and then
 * navigates into the app in the same tab keeps the container that page loaded.
 */
export function GoogleTagManager({ gtmId }: { gtmId: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(
    () => setEnabled(!isDesktop() && !isAnalyticsExcludedPath(window.location.pathname)),
    [],
  );
  if (!enabled) return null;
  return (
    <>
      <Script id="_next-gtm-init" strategy="lazyOnload">
        {`(function(w,l){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});})(window,'dataLayer');`}
      </Script>
      <Script
        id="_next-gtm"
        strategy="lazyOnload"
        src={`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`}
      />
    </>
  );
}
