'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';

/**
 * Cookie consent banner - GDPR compliant implementation
 * 
 * LEGAL REQUIREMENTS:
 * - CookieYes script MUST load on ALL pages to block analytics until consent is given
 * - Banner should be visible on homepage for new users to provide consent
 * - Banner can be hidden on dashboard to avoid blocking content (once consent is given, CookieYes won't show it again)
 * - Analytics scripts (GA, GTM, PostHog, Facebook Pixel) run globally and MUST be blocked until consent
 * 
 * This implementation:
 * 1. Loads CookieYes script on ALL pages (required for GDPR compliance)
 * 2. Hides banner on dashboard/authenticated pages to avoid blocking content
 * 3. Shows banner on homepage for users who haven't given consent
 * 4. CookieYes automatically manages consent state and won't show banner again after consent
 */
export function CookieConsent() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const scriptLoadedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Hide CookieYes banner on dashboard/authenticated pages to avoid blocking content
  // The script still loads to ensure analytics are blocked until consent is given
  useEffect(() => {
    if (!mounted) return;

    const isDashboardOrAuth = pathname?.startsWith('/dashboard') || 
                               pathname?.startsWith('/auth') ||
                               pathname?.startsWith('/agents') ||
                               pathname?.startsWith('/settings') ||
                               pathname?.startsWith('/thread');

    const manageCookieYesBanner = () => {
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
              if (isDashboardOrAuth) {
                // Hide banner on dashboard/auth pages to avoid blocking content
                // CookieYes will still block analytics until consent is given
                htmlEl.style.display = 'none';
                htmlEl.style.visibility = 'hidden';
                htmlEl.style.opacity = '0';
                htmlEl.style.pointerEvents = 'none';
              } else {
                // Show banner on homepage and other public pages
                // CookieYes will only show if user hasn't given consent yet
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
    manageCookieYesBanner();
    
    // Also run after a short delay to catch dynamically injected elements
    const timeoutId = setTimeout(manageCookieYesBanner, 100);
    
    // Use MutationObserver to catch any dynamically added CookieYes elements
    const observer = new MutationObserver(() => {
      manageCookieYesBanner();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [pathname, mounted]);

  // Load CookieYes script on ALL pages (required for GDPR compliance)
  // The script blocks analytics until consent is given, regardless of which page loads first
  if (!mounted) {
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

