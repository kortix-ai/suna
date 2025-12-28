'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';

/**
 * Cookie consent banner that ONLY shows on homepage (/)
 * Strictly prevents loading and hides any CookieYes elements on all other routes
 */
export function CookieConsent() {
  const pathname = usePathname();
  const [isHomepage, setIsHomepage] = useState(false);
  const [mounted, setMounted] = useState(false);
  const scriptLoadedRef = useRef(false);

  // Check if we're on homepage
  useEffect(() => {
    setMounted(true);
    const isHome = pathname === '/';
    setIsHomepage(isHome);
  }, [pathname]);

  // Hide CookieYes elements when NOT on homepage, show when on homepage
  useEffect(() => {
    if (!mounted) return;

    const hideCookieYesElements = () => {
      // CookieYes typically injects elements with these selectors
      const selectors = [
        '#cookieyes',
        '#cky-consent-bar',
        '.cky-consent-bar',
        '[id*="cookieyes"]',
        '[class*="cky-"]',
        '[id*="cky-"]',
      ];

      selectors.forEach((selector) => {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            const htmlEl = el as HTMLElement;
            if (htmlEl) {
              if (!isHomepage) {
                // Hide on non-homepage routes
                htmlEl.style.display = 'none';
                htmlEl.style.visibility = 'hidden';
                htmlEl.style.opacity = '0';
                htmlEl.style.pointerEvents = 'none';
              } else {
                // Show on homepage (remove any previously applied hide styles)
                htmlEl.style.display = '';
                htmlEl.style.visibility = '';
                htmlEl.style.opacity = '';
                htmlEl.style.pointerEvents = '';
              }
            }
          });
        } catch (e) {
          // Silently fail if selector is invalid
        }
      });
    };

    // Run immediately
    hideCookieYesElements();
    
    // Also run after a short delay to catch dynamically injected elements
    const timeoutId = setTimeout(hideCookieYesElements, 100);
    
    // Use MutationObserver to catch any dynamically added CookieYes elements
    const observer = new MutationObserver(() => {
      hideCookieYesElements();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [isHomepage, mounted]);

  // Only load the script on the homepage
  if (!mounted || !isHomepage) {
    return null;
  }

  return (
    <Script
      id="cookieyes"
      strategy="afterInteractive"
      src={`https://cdn-cookieyes.com/client_data/${process.env.NEXT_PUBLIC_COOKIEYES_ID || 'fa1588049104cfeadaa81aa4149644f2'}/script.js`}
      onLoad={() => {
        scriptLoadedRef.current = true;
      }}
      onError={() => {
        console.warn('CookieYes script failed to load');
      }}
    />
  );
}

