'use client';

import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { motion } from 'framer-motion';

import { Navbar } from '@/components/home/navbar';
import { SimpleFooter } from '@/components/home/simple-footer';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { Button } from '@/components/ui/button';

/**
 * The one, general 404 — rendered inside the marketing chrome (Navbar +
 * SimpleFooter + hero background) so every not-found across the app and the
 * marketing site looks the same.
 */
export default function NotFound() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="relative flex min-h-dvh w-full flex-col">
      <div className="fixed inset-x-0 top-0 z-50">
        <Navbar isAbsolute />
      </div>

      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-32 sm:px-6">
        {/* Marketing hero background */}
        <AnimatedBg variant="hero" />

        {/* Noise/static overlay, consistent with the error pages */}
        <div
          className="pointer-events-none absolute inset-0 z-0 opacity-[0.02] dark:opacity-[0.035]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'repeat',
            backgroundSize: '256px 256px',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 flex w-full max-w-[460px] flex-col items-center gap-6 text-center"
        >
          <motion.div
            className="select-none font-mono text-7xl font-bold leading-none tracking-tighter text-foreground/[0.07] sm:text-8xl"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, duration: 0.5 }}
          >
            404
          </motion.div>

          <h1 className="text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-5xl">
            {tHardcodedUi.raw('appNotFound.line65JsxTextPageNotFound')}
          </h1>
          <p className="px-2 text-sm leading-relaxed text-foreground/60 sm:text-base">
            {tHardcodedUi.raw('appNotFound.line70JsxTextThePageYouAposReLookingForDoesn')}
          </p>

          <div className="mt-1 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-center">
            <Button asChild size="lg" className="h-12 gap-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                {tHardcodedUi.raw('appNotFound.line100JsxTextReturnHome')}
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 gap-2">
              <Link href="/docs">
                <BookOpen className="h-4 w-4" />
                Documentation
              </Link>
            </Button>
          </div>
        </motion.div>
      </main>

      <SimpleFooter />
    </div>
  );
}
