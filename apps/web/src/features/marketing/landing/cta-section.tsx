'use client';

import { Button } from '@/components/ui/marketing/button';
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { DitherShader } from '@/components/ui/wallpaper-shaders';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { cta } from '@/features/marketing/landing/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/**
 * Closing CTA above the site map. Copy lives in content.ts, not the i18n
 * bundle, matching the rest of the rebuilt landing page.
 */
export function CtaSection() {
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
      <div
        className="pointer-events-none absolute inset-0 -top-4 [mask-image:linear-gradient(to_bottom,#000_0%,#000_30%,transparent_90%)] md:scale-110"
        aria-hidden
      >
        <DitherShader />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center px-6 text-center">
        <h2 className="text-foreground text-3xl leading-[1.15] font-medium tracking-tight text-balance sm:text-4xl lg:text-5xl">
          {cta.title}
        </h2>
        <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed text-pretty sm:mt-6 sm:text-lg">
          {cta.sub}
        </p>

        <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:mt-10 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <Button size="lg" className="w-full active:scale-[0.97] sm:w-auto sm:min-w-36" asChild>
            <HoverPrefetchLink href={launchHref} prefetch onClick={trackCtaSignup}>
              {cta.ctaPrimary}
              <ArrowRightIcon className="size-4 shrink-0" />
            </HoverPrefetchLink>
          </Button>
          <Button
            size="lg"
            variant="secondary"
            className="w-full active:scale-[0.97] sm:w-auto sm:min-w-36"
            onClick={() => openDemo()}
          >
            {cta.ctaSecondary}
          </Button>
        </div>
      </div>
    </section>
  );
}
