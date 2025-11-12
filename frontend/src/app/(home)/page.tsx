'use client';

import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { HeroSection as NewHeroSection } from '@/components/home/hero-section';
import { WordmarkFooter } from '@/components/home/wordmark-footer';

export default function Home() {
  return (
    <>
      <BackgroundAALChecker>
        <main className="w-full">
          <NewHeroSection />
          <WordmarkFooter />
        </main>
      </BackgroundAALChecker>
    </>
  );
}
