'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';

import { isDesktop } from '@/lib/desktop';

const VISITOR_PIXEL_SRC =
  'https://d2mvefebd70kbz.cloudfront.net/scripts/019e82ba-9ec3-733e-8a8e-9ff5cc2e1d35.js';

/** The pixel's domain verification is registered for the production site. */
function isKortixSiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'kortix.com' || host.endsWith('.kortix.com');
}

/**
 * Visitor-identification pixel (domain integration, script tag verification).
 *
 * Loaded after `window.load` + idle, like GTM — it was an `async` script in
 * the document head, fetched and executed during first render.
 *
 * Loads ONLY on the production site host: never on localhost (CI, local dev)
 * or preview hosts, where the vendor 400s the beacon — which failed every PR's
 * browser lane at the admin console's "no bad responses" guard. Never inside
 * the desktop app. Both checks run in the browser, so the root layout needs
 * no request headers for it.
 */
export function VisitorPixel() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(isKortixSiteHost(window.location.hostname) && !isDesktop());
  }, []);
  if (!enabled) return null;
  return (
    <Script id="visitor-pixel" src={VISITOR_PIXEL_SRC} strategy="lazyOnload" crossOrigin="anonymous" />
  );
}
