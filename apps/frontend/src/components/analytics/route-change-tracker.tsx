'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { trackRouteChange } from '@/lib/analytics/gtm';

/**
 * RouteChangeTracker Component
 * 
 * Tracks route changes in the Next.js app router and pushes
 * routeChange events to Google Tag Manager's dataLayer.
 * 
 * This solves the SPA tracking problem where page views aren't
 * automatically tracked on client-side navigation.
 */
export function RouteChangeTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isInitialMount = useRef(true);
  
  useEffect(() => {
    // On initial mount, track the current page
    if (isInitialMount.current) {
      isInitialMount.current = false;
      
      // Small delay to ensure document.title is set
      const timeoutId = setTimeout(() => {
        trackRouteChange(pathname, searchParams?.toString());
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
    
    // Track subsequent route changes
    trackRouteChange(pathname, searchParams?.toString());
  }, [pathname, searchParams]);
  
  // This component doesn't render anything
  return null;
}

