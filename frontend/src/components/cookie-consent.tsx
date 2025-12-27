'use client';

import Script from 'next/script';

/**
 * Cookie consent banner that only shows on homepage
 */
export function CookieConsent() {
  return (
    <Script
      id="cookieyes"
      strategy="beforeInteractive"
      src={`https://cdn-cookieyes.com/client_data/${process.env.NEXT_PUBLIC_COOKIEYES_ID || 'fa1588049104cfeadaa81aa4149644f2'}/script.js`}
    />
  );
}

