'use client';

import { Suspense, lazy } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';

// Lazy load components
const MobileAppInterstitial = lazy(() =>
  import('@/components/announcements/mobile-app-interstitial').then(mod => ({ default: mod.MobileAppInterstitial }))
);

export default function Home() {
  return (
    <BackgroundAALChecker>
      <div className="h-dvh">
        <NewHeroSection />
        {/* Mobile app banner - shown on mobile devices for logged-in users */}
        <Suspense fallback={null}>
          <MobileAppInterstitial />
        </Suspense>
      </div>
    </BackgroundAALChecker>
  );
}
