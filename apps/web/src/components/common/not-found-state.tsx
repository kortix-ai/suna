'use client';

import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { motion } from 'framer-motion';

import { Button } from '@/components/ui/button';

interface NotFoundAction {
  href: string;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'outline';
}

/**
 * The shared 404 card — the big "404" numeral, heading, blurb and actions.
 *
 * Chrome-free on purpose: the marketing `not-found.tsx` wraps it in the
 * Navbar + hero background + footer, while the dashboard `not-found.tsx`
 * drops it inside the project shell. Same content, two frames.
 */
export function NotFoundCard({
  title,
  description,
  actions,
}: {
  title?: string;
  description?: string;
  actions?: NotFoundAction[];
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const resolvedActions: NotFoundAction[] = actions ?? [
    {
      href: '/',
      label: tHardcodedUi.raw('appNotFound.line100JsxTextReturnHome'),
      icon: <ArrowLeft className="h-4 w-4" />,
    },
    {
      href: '/docs',
      label: 'Documentation',
      icon: <BookOpen className="h-4 w-4" />,
      variant: 'outline',
    },
  ];

  return (
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
        {title ?? tHardcodedUi.raw('appNotFound.line65JsxTextPageNotFound')}
      </h1>
      <p className="px-2 text-sm leading-relaxed text-foreground/60 sm:text-base">
        {description ??
          tHardcodedUi.raw(
            'appNotFound.line70JsxTextThePageYouAposReLookingForDoesn',
          )}
      </p>

      <div className="mt-1 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-center">
        {resolvedActions.map((action) => (
          <Button
            key={action.href + action.label}
            asChild
            size="lg"
            variant={action.variant ?? 'default'}
            className="h-12 gap-2"
          >
            <Link href={action.href}>
              {action.icon}
              {action.label}
            </Link>
          </Button>
        ))}
      </div>
    </motion.div>
  );
}

/**
 * The faint fractal-noise overlay shared by the 404 / error surfaces. Absolutely
 * positioned, so the parent must be `relative`.
 */
export function NotFoundNoise() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 opacity-[0.02] dark:opacity-[0.035]"
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'repeat',
        backgroundSize: '256px 256px',
      }}
    />
  );
}
