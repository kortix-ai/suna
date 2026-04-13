'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import * as Sentry from '@sentry/nextjs';

export default function HomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden px-3 sm:px-6">
      {/* Animated background for visual consistency with home pages */}
      <AnimatedBg variant="hero" />

      {/* Noise overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.025] dark:opacity-[0.04]"
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
        className="relative z-10 flex w-full max-w-[456px] flex-col items-center gap-6 sm:gap-8"
      >
        {/* Logo */}
        <KortixLogo size={28} className="sm:w-8 sm:h-8" />

        {/* Error text art */}
        <div className="relative select-none">
          <motion.pre
            className="font-mono text-xs leading-tight text-foreground/[0.08] sm:text-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.6 }}
          >
{`  ___  ___  ___
 | __|| _ \\| _ \\
 | _| |   /|   /
 |___|_|_\\|_|_\\`}
          </motion.pre>
        </div>

        {/* Title */}
        <h1 className="text-center text-3xl font-normal tracking-tight text-foreground sm:text-[43px] sm:leading-tight">
          Something went wrong
        </h1>

        {/* Description */}
        <p className="px-2 text-center text-sm leading-relaxed text-muted-foreground sm:text-base">
          We encountered an unexpected error. Please try again or return to the homepage.
        </p>

        {/* Status pill */}
        <motion.div
          className="flex items-center gap-2 rounded-full border border-border/60 bg-card/60 px-4 py-2 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
        >
          <motion.div
            className="h-1.5 w-1.5 rounded-full bg-amber-500"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span className="font-mono text-xs text-muted-foreground">
            attempting recovery
          </span>
        </motion.div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-3 sm:flex-row">
          <Button size="lg" className="h-12 flex-1" onClick={reset}>
            <RotateCcw className="h-4 w-4" />
            Try Again
          </Button>
          <Button size="lg" variant="outline" className="h-12 flex-1" asChild>
            <Link href="/" className="flex items-center justify-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              Return Home
            </Link>
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
