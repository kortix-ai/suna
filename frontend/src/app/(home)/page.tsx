'use client';

import { Suspense } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';
import { WordmarkFooter } from '@/components/home/wordmark-footer';

export default function Home() {
  return (
    <>
      <BackgroundAALChecker>
        <main className="w-full">
          <Suspense fallback={null}>
            <NewHeroSection />
          </Suspense>
          <WordmarkFooter />
        </main>
      </BackgroundAALChecker>
    </>
  );
}
