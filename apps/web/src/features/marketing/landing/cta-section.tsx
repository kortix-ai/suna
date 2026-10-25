'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { getLocalizedLandingContent } from '@/features/marketing/landing/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';

/**
 * Closing CTA above the site map. Copy lives in content.ts, not the i18n
 * bundle, matching the rest of the rebuilt landing page.
 */
export function CtaSection() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { cta } = getLocalizedLandingContent(tI18nComplete);
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  // `latestProjectPath` reads document.cookie, which the server pass cannot
  // see. Seeding with `/auth` keeps both passes identical and lets the row be a
  // real anchor: hydration adopts the remembered project afterwards. An anchor
  // is what gives the site's primary closing CTA middle-click, cmd-click and
  // "copy link address" — a button has none of them.
  //
  // `HoverPrefetchLink`, so an anonymous visitor scrolling past the footer does
  // not prefetch an authed route it will never open.
  const [launchHref, setLaunchHref] = useState('/auth');
  useEffect(() => {
    if (!user) return;
    const href = latestProjectPath(user.id);
    setLaunchHref((prev) => (prev === href ? prev : href));
  });

  return (
    <section id="cta" className="py-24 sm:py-30">
      {/* Buio's hero dither, as a flat field rather than an orb. It covers
          only the band above the heading and fades out before the title, so
          the copy sits on the plain surface. Two mask layers, added: a
          straight fade that ends at 150px across the full width, and a
          centred ellipse that carries the middle down to 300px. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-81.5 [mask-image:linear-gradient(to_bottom,#000,transparent_150px),radial-gradient(50%_300px_at_50%_0,#000,transparent)]"
        aria-hidden
      >
        <DitherField />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center px-6 text-center">
        {/* Two-tone marketing title, then one line of description. */}
        <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance md:text-3xl lg:text-4xl">
          {cta.title}
          <span className="text-muted-foreground block">{cta.subtitle}</span>
        </h2>
        <p className="text-muted-foreground mt-4 text-lg text-pretty">{cta.sub}</p>

        <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <MarketingButton size="md" className="hit-area-y-1 w-full sm:w-auto sm:min-w-36" asChild>
            <HoverPrefetchLink href={launchHref} prefetch onClick={trackCtaSignup}>
              {cta.ctaPrimary}
              <ArrowRightIcon />
            </HoverPrefetchLink>
          </MarketingButton>
          <MarketingButton
            variant="secondary"
            size="md"
            className="hit-area-y-1 w-full sm:w-auto sm:min-w-36"
            onClick={() => openDemo()}
          >
            {cta.ctaSecondary}
          </MarketingButton>
        </div>
      </div>
    </section>
  );
}
