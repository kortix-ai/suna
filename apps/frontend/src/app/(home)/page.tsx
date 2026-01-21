'use client';

import { Suspense, lazy, useEffect } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';

// Lazy load components
const MobileAppInterstitial = lazy(() =>
  import('@/components/announcements/mobile-app-interstitial').then(mod => ({ default: mod.MobileAppInterstitial }))
);

export default function Home() {
  // Prevent body scroll on home page only
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <BackgroundAALChecker>
      <div className="h-dvh overflow-hidden">
        <NewHeroSection />
        {/* Mobile app banner - shown on mobile devices for logged-in users */}
        <Suspense fallback={null}>
          <MobileAppInterstitial />
        </Suspense>
      </div>
    </BackgroundAALChecker>
  );
}
