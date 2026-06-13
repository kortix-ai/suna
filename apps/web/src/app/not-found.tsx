'use client';

import { NotFoundCard, NotFoundNoise } from '@/components/common/not-found-state';
import Footer from '@/components/home/footer';
import { Navbar } from '@/components/home/navbar';
import { AnimatedBg } from '@/components/ui/animated-bg';

/**
 * The general 404 — rendered inside the marketing chrome (Navbar +
 * SimpleFooter + hero background). It's the not-found boundary for the
 * marketing site and any route outside the project shell.
 *
 * Inside `/projects/[id]/*` the dashboard-flavored 404 takes over — see
 * `app/projects/[id]/not-found.tsx`. Both share `<NotFoundCard />`.
 */
export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh w-full flex-col">
      <div className="fixed inset-x-0 top-0 z-50">
        <Navbar isAbsolute />
      </div>

      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-32 sm:px-6">
        {/* Marketing hero background */}
        <AnimatedBg variant="hero" />

        {/* Noise/static overlay, consistent with the error pages */}
        <NotFoundNoise />

        <NotFoundCard />
      </main>

      <Footer />
    </div>
  );
}
