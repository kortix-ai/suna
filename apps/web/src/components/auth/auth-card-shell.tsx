'use client';

import { useTranslations } from 'next-intl';

/**
 * Shared brand surface for the auth sub-flows (forgot / reset password).
 *
 * Mirrors the frosted-glass card on the main `/auth` page — same wallpaper,
 * same blur, same card chrome — minus the lock-screen, since these pages are
 * landed on directly from an email link rather than unlocked.
 */

import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';

export function AuthCardShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  /** Optional centered footer (e.g. a "Back to sign in" link). */
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 overflow-hidden">
      <WallpaperBackground wallpaperId="brandmark" />
      <div className="absolute inset-0 bg-background/20 backdrop-blur-[2px]" />

      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-4">
        <motion.div
          className="w-full max-w-[400px]"
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="bg-background/75 dark:bg-background/70 backdrop-blur-2xl border border-foreground/[0.08] rounded-2xl p-7 max-h-[calc(100vh-4rem)] overflow-y-auto">
            <div className="flex flex-col items-center mb-5 text-center">
              <h1 className="text-base font-medium text-foreground/90 tracking-tight">
                {title}
              </h1>
              <p className="text-sm text-foreground/40 mt-0.5">{description}</p>
            </div>

            {children}

            {footer && <div className="mt-5 text-center">{footer}</div>}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/** Consistent "Back to sign in" link used across the auth sub-flows. */
export function BackToSignIn() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Link
      href="/auth"
      className="inline-flex items-center gap-1.5 text-xs text-foreground/40 hover:text-foreground/70 underline-offset-4 hover:underline transition-colors"
    >
      <ArrowLeft className="size-3" />{tHardcodedUi.raw('componentsAuthAuthCardShell.line67JsxTextBackToSignIn')}</Link>
  );
}
