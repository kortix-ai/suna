'use client';

import { isDesktop } from '@/lib/desktop';
import { GoogleTagManager } from '@next/third-parties/google';
import { useEffect, useState } from 'react';

/**
 * Google Tag Manager for the website only.
 *
 * The desktop app sends a `KortixDesktop` user agent. The page HTML is static,
 * so the check runs in the browser: GTM mounts only after the effect confirms
 * the page is not inside the desktop shell. GTM injects its scripts
 * `afterInteractive` either way, so the load timing on the website is the same.
 */
export function WebOnlyGoogleTagManager({ gtmId }: { gtmId: string }) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(!isDesktop());
  }, []);
  return allowed ? <GoogleTagManager gtmId={gtmId} /> : null;
}
