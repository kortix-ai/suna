'use client';
import { useTranslations } from '@/i18n/use-translations';

import { ConsentGate } from '@/components/consent-gate';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from '@/components/site-link';
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
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const openDemo = useRequestDemo();
  return (
    <div className="bg-background relative min-h-dvh w-full">
      <ConsentGate />
      <SmoothScroll />
      <header
        className="bg-background fixed top-0 right-0 left-0 z-50 border-b"
        data-kx-titlebar-owner=""
      >
        <div className={cn(MARKETING_CONTAINER, 'flex h-16 items-center gap-4')}>
          <Link
            href="/"
            aria-label={tMarketing('text7ecec93ed268')}
            className="text-foreground outline-ring flex h-16 items-center rounded-sm focus-visible:outline-2"
          >
            <KortixLogo size={15} variant="logomark" />
          </Link>
          <SiteSwitcher className="mr-auto" />
          {/* designjoy's bar: jump to the parts a buyer checks. Phones keep Pricing only. */}
          <a href="#how-it-works" className={cn(BAR_LINK, 'md:hidden lg:flex')}>
            {tMarketing('text9c870aa6e5e9')}
          </a>
          <a href="#how" className={cn(BAR_LINK, 'md:hidden lg:flex')}>
            {tMarketing('text8783c085bdc9')}
          </a>
          <a href="#case-studies" className={cn(BAR_LINK, 'md:hidden lg:flex')}>
            {tMarketing('textd355d4fd2a9c')}
          </a>
          <a href="#pricing" className={BAR_LINK}>
            {tMarketing('textdfe95783edfe')}
          </a>
          <a href="#faq" className={cn(BAR_LINK, 'md:hidden lg:flex')}>
            FAQ
          </a>
          <MarketingButton
            className="hit-area-y-3"
            onClick={() => openDemo({ source: 'services' })}
          >
            <span className="sm:hidden">{tMarketing('text5461243c8731')}</span>
            <span className="hidden sm:inline">{tMarketing('text6def5bd6334e')}</span>
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
