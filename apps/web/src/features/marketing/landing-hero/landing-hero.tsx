'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { useTranslations } from '@/i18n/use-translations';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import Link from 'next/link';

import { SessionWindow } from './session-window';

const CHLADNI_BAND = '/media/landing/chladni-band.webp';

/**
 * Landing hero (Paper "Kortix 2": copy layout I07-0, band and window
 * slot from G96-0, live window HVL-0 in place of the video). A dark band
 * carries the copy and runs to the middle of the window, so the product sits half on the band and half on the page.
 *
 * The band is a `dark` scope over `bg-background`, not a raw black: the kit's
 * way to paint one dark surface on a light page. Its bottom edge follows the
 * window's rendered height: the window keeps the board's 1264 × 860 ratio
 * inside the 1440 column less `--gutter` on each side, so half its height is
 * (min(1440px, 100vw) − 2 × gutter) × 860 / 1264 / 2, plus the section's
 * bottom padding.
 *
 * `--gutter` holds the same two values as the kit's `MARKETING_CONTAINER`
 * (`px-4 lg:px-24`), so the hero lines up with the bar and every section.
 * The buttons read the bar's own catalog keys, so the hero and the bar say
 * the same words in every locale.
 */
export function LandingHero() {
  const openDemo = useRequestDemo();
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <section
      id="hero"
      className="relative overflow-hidden pb-24 [--gutter:calc(var(--spacing)*4)] lg:[--gutter:calc(var(--spacing)*24)]"
    >
      {/* `data-hero-band`: the navbar keeps its dark scope while this band is under it. */}
      <div
        aria-hidden
        data-hero-band
        className="dark bg-background absolute inset-x-0 top-0 overflow-hidden"
        style={{
          bottom: 'calc(var(--spacing) * 24 + (min(1440px, 100vw) - 2 * var(--gutter)) * 0.3402)',
        }}
      >
        {/* Chladni sand plate (mode 3·7) across the whole band. The grains are
            an alpha mask painted in the band's ink, so they follow the theme. */}
        <div
          className="bg-foreground absolute top-0 left-1/2 aspect-[3/1] h-full -translate-x-1/2 opacity-20"
          style={{ maskImage: `url(${CHLADNI_BAND})`, maskSize: '100% 100%' }}
        />
      </div>

      {/* Paper I07-0: headline on the left, then one row with the sub on the
          left and the two actions on the right, then the works-with line. */}
      <div className="dark text-foreground relative mx-auto flex max-w-[1440px] flex-col gap-10 px-(--gutter) pt-28 pb-14">
        <h1 className="kx-hero-text max-w-160 text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
          The open-source AI Operating System.
        </h1>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <p className="kx-hero-text max-w-158 text-base [--kx-enter:150ms]">
            Your agents, skills, company memory and connectors in one git repo you own. Any model,
            your keys, self-hosted or managed cloud.
          </p>
          <div className="kx-hero-text flex items-center gap-2 [--kx-enter:220ms]">
            <MarketingButton
              size="md" className="hit-area-y-1"
              variant="secondary"
              onClick={() => openDemo({ source: 'landing-hero' })}
            >
              {tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}
            </MarketingButton>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/auth" onClick={trackCtaSignup}>
                {tHardcodedUi.raw('componentsHomeNavbar.line312JsxTextGetStarted')}
              </Link>
            </MarketingButton>
          </div>
        </div>
        <p className="kx-hero-text text-muted-foreground text-sm [--kx-enter:290ms]">
          Works with Slack, Teams, GitHub and any model.
        </p>
      </div>

      <div id="demo" className="kx-hero-frame relative mx-auto max-w-[1440px] scroll-mt-24 px-(--gutter) [--kx-enter:360ms]">
        <SessionWindow />
      </div>
    </section>
  );
}
