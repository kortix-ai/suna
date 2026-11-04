'use client';
import { useTranslations } from '@/i18n/use-translations';

import { ConsentGate } from '@/components/consent-gate';
import { Navbar } from '@/components/home/navbar';
import Link from '@/components/site-link';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { SmoothScroll } from '@/features/marketing/kit/smooth-scroll';
import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/**
 * The shell of the /services sales page: the site navbar on top (the same as
 * every CompanyOS page), a one-line footer at the bottom.
 */
export function SalesShell({ children }: { children: ReactNode }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="bg-background relative min-h-dvh w-full">
      <ConsentGate />
      <SmoothScroll />
      {/* The site's own navbar, the same as on every CompanyOS page: Product,
          Resources, Pricing, and the CompanyOS / Services switcher in the middle. */}
      <div className="fixed top-0 right-0 left-0 z-50" data-kx-titlebar-owner="">
        {/* Solid from the top: the hero's dither field runs under the bar. */}
        <Navbar solidAtTop />
      </div>
      {children}
      <footer className="border-t">
        <div
          className={cn(
            MARKETING_CONTAINER,
            'text-muted-foreground flex flex-col gap-4 py-10 pb-28 text-sm sm:flex-row sm:items-center sm:justify-between lg:pb-10',
          )}
        >
          <span>© {new Date().getFullYear()} Kortix</span>
          <nav
            aria-label={tMarketing('text26c87bb51e69')}
            className="flex flex-wrap gap-x-6 gap-y-2"
          >
            <Link href="/" className="hover:text-foreground">
              {tMarketing('text4370c8845eed')}
            </Link>
            <Link href="/security" className="hover:text-foreground">
              {tMarketing('text8f6fb4eb7f42')}
            </Link>
            <Link href="/legal/terms" className="hover:text-foreground">
              {tMarketing('textede548996483')}
            </Link>
            <Link href="/legal?tab=privacy" className="hover:text-foreground">
              {tMarketing('text54a57c3147c4')}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
