'use client';

import { useTranslations } from 'next-intl';

/**
 * Shared quiet surface for the auth sub-flows (forgot / reset password).
 *
 * Mirrors the main `/auth` page: flat content on the plain background — no
 * card — with the Kortix mark above a left-aligned heading, and the legal
 * footer pinned to the bottom.
 */

import { ChevronLeft } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';

import { KortixLogo } from '@/components/ui/kortix-logo';

const EASE = [0.23, 1, 0.32, 1] as const;

/** Tiny legal line pinned to the bottom of every auth surface. */
export function AuthLegalFooter({ variant = 'default' }: { variant?: 'default' | 'signup' }) {
  const terms = (
    <Link
      href="/legal?tab=terms"
      className="hover:text-muted-foreground underline-offset-4 transition-colors hover:underline"
    >
      Terms of Service
    </Link>
  );
  const privacy = (
    <Link
      href="/legal?tab=privacy"
      className="hover:text-muted-foreground underline-offset-4 transition-colors hover:underline"
    >
      Privacy Policy
    </Link>
  );

  return (
    <footer className="text-muted-foreground/60 mx-auto max-w-[380px] px-4 pb-10 text-center text-sm text-balance">
      {variant === 'signup' ? (
        <>By creating an account, you agree to the {terms} and {privacy}</>
      ) : (
        <>
          {terms} and {privacy}
        </>
      )}
    </footer>
  );
}

export function AuthCardShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  /** Optional footer below the content (e.g. a "Back to sign in" link). */
  footer?: React.ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: EASE },
  });

  return (
    <div className="bg-background flex min-h-svh flex-col">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-24">
        <div className="w-full max-w-[380px]">
          <motion.div {...rise(0)}>
            <div className="mb-10">
              <KortixLogo variant="icon" size={22} className="text-foreground" />
              <h1 className="text-foreground mt-6 text-2xl font-medium tracking-tight text-balance">
                {title}
              </h1>
              <p className="text-muted-foreground mt-2 text-sm text-pretty">{description}</p>
            </div>
          </motion.div>

          <motion.div {...rise(0.06)}>
            {children}
            {footer ? <div className="mt-8">{footer}</div> : null}
          </motion.div>
        </div>
      </main>

      <AuthLegalFooter />
    </div>
  );
}

/** Consistent "Back to sign in" link used across the auth sub-flows. */
export function BackToSignIn() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Link
      href="/auth"
      className="text-muted-foreground hover:text-foreground -m-2 inline-flex items-center gap-1 rounded-sm p-2 text-sm transition-colors"
    >
      <ChevronLeft className="size-4" />
      {tHardcodedUi.raw('componentsAuthAuthCardShell.line67JsxTextBackToSignIn')}
    </Link>
  );
}
