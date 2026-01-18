'use client';

import { Suspense, lazy } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';

// Lazy load below-the-fold components for faster FCP/LCP
const WordmarkFooter = lazy(() => 
  import('@/components/home/wordmark-footer').then(mod => ({ default: mod.WordmarkFooter }))
);
const SimpleFooter = lazy(() => 
  import('@/components/home/simple-footer').then(mod => ({ default: mod.SimpleFooter }))
);
const MobileAppInterstitial = lazy(() =>
  import('@/components/announcements/mobile-app-interstitial').then(mod => ({ default: mod.MobileAppInterstitial }))
);

export default function Home() {
  return (
    <BackgroundAALChecker>
      <NewHeroSection />
      <Suspense fallback={null}>
        <WordmarkFooter />
      </Suspense>
      <Suspense fallback={null}>
        <SimpleFooter />
      </Suspense>
      {/* Mobile app banner - shown on mobile devices for logged-in users */}
      <Suspense fallback={null}>
        <MobileAppInterstitial />
      </Suspense>
    </BackgroundAALChecker>
  );
}
