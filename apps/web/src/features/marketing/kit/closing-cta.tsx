'use client';

import Link from 'next/link';

import { FREE_MONTHLY_CREDITS } from '@kortix/ui/internal/billing/compute-pricing';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';
import { useTranslations } from '@/i18n/use-translations';
import { trackCtaSignup } from '@/lib/analytics/gtm';

const CHLADNI_BAND = '/media/landing/chladni-band.webp';

/**
 * The closing call to action (Buio's CTA box), the last section of a
 * marketing page: a centred two-tone heading and the bar's two actions,
 * inside side hairlines, over the Chladni plate the hero band carries, so a
 * page ends where the home page started. The plate is an alpha mask painted
 * in the ink colour, so it follows the theme.
 *
 * The footer renders no call to action, so a page that should end on one
 * renders this. `source` tags the demo request with the page it came from.
 */
export function ClosingCta({ source }: { source: string }) {
  const openDemo = useRequestDemo();
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <Section id="get-started">
      <div className="border-border relative overflow-hidden border-x px-6 pt-20 pb-30">
        <div
          aria-hidden
          className="bg-foreground absolute inset-x-0 bottom-0 aspect-[3/1] opacity-10"
          style={{
            maskImage: `url(${CHLADNI_BAND}), linear-gradient(to top, black, transparent)`,
            maskComposite: 'intersect',
            maskSize: '100% 100%',
          }}
        />
        <SectionHeading
          align="center"
          title="Start with one job."
          titleMuted="Grow from there."
          description={`Free is $0 with ${FREE_MONTHLY_CREDITS} credits per month, managed models and every feature.`}
          className="relative"
          actions={
            <>
              <MarketingButton
                size="md"
                variant="secondary"
                className="hit-area-y-1"
                onClick={() => openDemo({ source })}
              >
                {tHardcodedUi.raw('componentsHomeNavbar.line301JsxTextRequestDemo')}
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href="/auth" onClick={trackCtaSignup}>
                  {tHardcodedUi.raw('componentsHomeNavbar.line312JsxTextGetStarted')}
                </Link>
              </MarketingButton>
            </>
          }
        />
      </div>
    </Section>
  );
}
