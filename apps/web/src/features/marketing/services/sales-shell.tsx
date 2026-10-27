'use client';

import { ConsentGate } from '@/components/consent-gate';
import Link from '@/components/site-link';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { SiteSwitcher } from '@/features/marketing/kit/site-switcher';
import { SmoothScroll } from '@/features/marketing/kit/smooth-scroll';
import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

const BAR_LINK =
  'text-foreground hover:text-muted-foreground outline-ring duration-moderate hidden h-8 items-center rounded-sm px-3 text-sm transition-colors focus-visible:outline-2 md:flex';

/**
 * The standalone shell of the /services sales page: no site nav, no mega
 * menus. The logo, the AI OS | Services switcher, two anchors and the intro
 * call on top; a one-line footer at the bottom.
 */
export function SalesShell({ children }: { children: ReactNode }) {
  const openDemo = useRequestDemo();
  return (
    <div className="bg-background relative min-h-dvh w-full">
      <ConsentGate />
      <SmoothScroll />
      <header className="bg-background fixed top-0 right-0 left-0 z-50 border-b" data-kx-titlebar-owner="">
        <div className={cn(MARKETING_CONTAINER, 'flex h-16 items-center gap-4')}>
          <Link href="/" aria-label="Kortix home" className="text-foreground outline-ring flex h-16 items-center rounded-sm focus-visible:outline-2">
            <KortixLogo size={15} variant="logomark" />
          </Link>
          <SiteSwitcher className="mr-auto" />
          <a href="#how" className={BAR_LINK}>
            What we do
          </a>
          <a href="#pricing" className={BAR_LINK}>
            Pricing
          </a>
          <MarketingButton className="hit-area-y-3" onClick={() => openDemo({ source: 'services' })}>
            <span className="sm:hidden">Book a call</span>
            <span className="hidden sm:inline">Book an intro call</span>
          </MarketingButton>
        </div>
      </header>
      {children}
      <footer className="border-t">
        <div
          className={cn(
            MARKETING_CONTAINER,
            'text-muted-foreground flex flex-col gap-4 py-10 pb-28 text-sm sm:flex-row sm:items-center sm:justify-between lg:pb-10',
          )}
        >
          <span>© {new Date().getFullYear()} Kortix</span>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/" className="hover:text-foreground">
              The AI OS
            </Link>
            <Link href="/security" className="hover:text-foreground">
              Security
            </Link>
            <Link href="/legal/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="/legal?tab=privacy" className="hover:text-foreground">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
