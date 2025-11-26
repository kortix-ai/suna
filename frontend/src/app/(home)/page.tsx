'use client';

import { Suspense, lazy } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';

// Lazy load below-the-fold components for faster FCP/LCP
const ShowCaseSection = lazy(() => 
  import('@/components/home/showcase-section').then(mod => ({ default: mod.ShowCaseSection }))
);
const WordmarkFooter = lazy(() => 
  import('@/components/home/wordmark-footer').then(mod => ({ default: mod.WordmarkFooter }))
);

// Skeleton placeholder for ShowCaseSection while loading
function ShowCaseSkeleton() {
  return (
    <section className="w-full px-6 py-16 md:py-24 lg:py-32">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12 md:mb-16">
          <div className="h-12 w-96 max-w-full mx-auto bg-muted/30 rounded-lg animate-pulse" />
          <div className="h-6 w-80 max-w-full mx-auto bg-muted/20 rounded-lg mt-4 animate-pulse" />
        </div>
        <div className="space-y-6">
          {[1, 2].map((i) => (
            <div key={i} className="h-[400px] bg-muted/10 rounded-[24px] animate-pulse" />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <BackgroundAALChecker>
        <main className="w-full">
          {/* Hero is critical for LCP - load immediately */}
          <NewHeroSection />
          
          {/* Below-the-fold content - lazy loaded with Suspense */}
          <Suspense fallback={<ShowCaseSkeleton />}>
            <ShowCaseSection />
          </Suspense>
          
          <Suspense fallback={null}>
            <WordmarkFooter />
          </Suspense>
        </main>
      </BackgroundAALChecker>
    </>
  );
}
