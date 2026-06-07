'use client';

import { useEffect } from 'react';

/**
 * Enables the GTM-injected CookieYes consent banner only while mounted.
 *
 * CookieYes is loaded globally via Google Tag Manager, so without this its
 * banner and floating "revisit" button show up everywhere — including the
 * authenticated app — which is noisy and irrelevant there. globals.css hides
 * every CookieYes surface by default; mounting this component (in the public
 * marketing `(home)` layout) adds `.consent-enabled` to <html> so the banner
 * appears on the marketing site and nowhere else.
 */
export function ConsentGate() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('consent-enabled');
    return () => root.classList.remove('consent-enabled');
  }, []);

  return null;
}
