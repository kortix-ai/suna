'use client';

import { Suspense, lazy } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';

const WordmarkFooter = lazy(() => 
  import('@/components/home/wordmark-footer').then(mod => ({ default: mod.WordmarkFooter }))
);

export default function Home() {
  return (
    <BackgroundAALChecker>
      <NewHeroSection />
      <Suspense fallback={null}>
        <WordmarkFooter />
      </Suspense>
    </BackgroundAALChecker>
  );
}
