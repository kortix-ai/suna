'use client';

import { useTranslations } from 'next-intl';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import * as Sentry from '@sentry/nextjs';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { useEffect } from 'react';

export default function HomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  useEffect(() => {
    console.error('[Kortix Home Error]', error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden px-3 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="relative z-10 flex w-full max-w-[456px] flex-col items-center gap-6 sm:gap-8"
      >
        {/* Logo */}
        <KortixLogo size={28} className="sm:h-8 sm:w-8" />

        {/* Error text art */}
        <div className="relative select-none">
          <motion.pre
            className="text-foreground/[0.08] font-mono text-xs leading-tight sm:text-sm"
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
        <h1 className="text-foreground text-center text-3xl font-normal tracking-tight sm:text-5xl sm:leading-tight">
          {tHardcodedUi.raw('appHomeError.line65JsxTextSomethingWentWrong')}
        </h1>

        {/* Description */}
        <p className="text-muted-foreground px-2 text-center text-sm leading-relaxed sm:text-base">
          {tHardcodedUi.raw(
            'appHomeError.line70JsxTextWeEncounteredAnUnexpectedErrorPleaseTryAgain',
          )}
        </p>

        {/* Status pill */}
        <motion.div
          className="border-border/60 bg-card/60 flex items-center gap-2 rounded-full border px-4 py-2 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
        >
          <motion.div
            className="h-1.5 w-1.5 rounded-full bg-amber-500"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span className="text-muted-foreground font-mono text-xs">
            {tHardcodedUi.raw('appHomeError.line86JsxTextAttemptingRecovery')}
          </span>
        </motion.div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-3 sm:flex-row">
          <Button size="lg" className="h-12 flex-1" onClick={reset}>
            <RotateCcw className="h-4 w-4" />
            {tHardcodedUi.raw('appHomeError.line94JsxTextTryAgain')}
          </Button>
          <Button size="lg" variant="outline" className="h-12 flex-1" asChild>
            <Link href="/" className="flex items-center justify-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {tHardcodedUi.raw('appHomeError.line99JsxTextReturnHome')}
            </Link>
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
