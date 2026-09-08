import { ArrowRightIcon as HiArrowRight } from '@/lib/icons/ssr';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';

/**
 * Closing CTA for the use-cases surface. Mirrors the landing page `#cta`
 * treatment (KortixGrid field + card) so the section reads as one platform.
 */
export function UseCasesCta() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-24 md:py-30 lg:px-0">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-sm border">
          <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
            <div className="col-span-5 flex flex-col items-start justify-center space-y-4 p-8 sm:p-10">
              <Badge variant="kortix" className="rounded">
                {tI18nComplete.raw('text7cdb8d6538c7')}
              </Badge>
              <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                {tI18nComplete.raw('textd2c165305573')}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {tI18nComplete.raw('text102fd4438086')}
              </p>
              <p className="text-muted-foreground text-xs tracking-wider">
                {tI18nComplete.raw('text21d4eb49638e')}
              </p>
              <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:max-w-xs">
                <Button asChild size="lg" className="w-full">
                  <Link href="/auth">
                    {tI18nComplete.raw('text61e8d44ad423')}
                    <HiArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="secondary" className="w-full">
                  <Link href="/enterprise">{tI18nComplete.raw('textcfd0b0225710')}</Link>
                </Button>
              </div>
            </div>
            <div className="col-span-1 hidden md:block" />
            <div className="col-span-6 mask-y-from-90% mask-x-from-90%">
              <KortixGrid count={58} seed={4228} />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
