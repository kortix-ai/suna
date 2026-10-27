import Link from '@/components/site-link';
import { cn } from '@kortix/ui';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { FeatureSplit } from '../kit/feature-split';
import { MarketingButton } from '../kit/marketing-button';
import { Band, Block, Heading, PageFrame, SpecGrid } from '../kit/page-frame';
import { SURFACE_ORDER, type SurfaceContent, type SurfaceId } from './content';
import { SurfaceMark } from './surface-mark';

/**
 * One page per place Kortix runs: /desktop, /mobile, /cli, /slack, /teams.
 *
 * Layout, top to bottom, in the landing page's frame (`PageFrame`):
 *  1. A centred two-tone hero over the stage: the product itself, rising from
 *     the band's foot, with one card floating over it.
 *  2. Four facts in a band (`SpecGrid`).
 *  3. The page's sections (`FeatureSplit`: title left, short copy right,
 *     one-line cells in a band).
 *  4. The other places Kortix runs, one cell each, so a reader moves between
 *     the surfaces without the navbar.
 * The closing call to action is the footer's.
 */
export function SurfacePage({ content, stage }: { content: SurfaceContent; stage: ReactNode }) {
  return (
    <PageFrame>
      <SurfaceHero content={content} stage={stage} />

      {content.sections.map((section) => (
        <FeatureSplit
          key={section.id}
          id={section.id}
          title={section.title}
          titleMuted={section.titleMuted}
          body={section.body}
          cells={section.cells}
          cols={section.cols}
        />
      ))}

      <OtherSurfaces current={content.id} />
    </PageFrame>
  );
}

/** The centred two-tone hero, its stage in a band, and the four facts under it. */
export function SurfaceHero({ content, stage }: { content: SurfaceContent; stage: ReactNode }) {
  const { hero } = content;
  return (
    <section id="hero">
      <div className="flex flex-col items-center gap-7.5 px-8 pt-32 pb-16 text-center lg:px-28 lg:pt-44 lg:pb-20">
        <div className="flex flex-col items-center gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">{hero.sub}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2.5 pt-2">
          {hero.actions.map((action) => (
            <MarketingButton
              key={action.href}
              variant={action.primary ? 'primary' : 'secondary'}
              size="md"
              className="hit-area-y-1"
              asChild
            >
              <Link
                href={action.href}
                {...(action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {action.icon ? <SurfaceMark id={action.icon} /> : null}
                {action.label}
              </Link>
            </MarketingButton>
          ))}
        </div>
        {hero.note ? <p className="text-muted-foreground text-sm">{hero.note}</p> : null}
      </div>
      <Band>{stage}</Band>
      <Band className="border-t-0">
        <SpecGrid items={content.specs} cols="lg:grid-cols-4" />
      </Band>
    </section>
  );
}

/** The other places Kortix runs, one cell each. */
export function OtherSurfaces({ current }: { current: SurfaceId }) {
  const others = SURFACE_ORDER.filter((s) => s.id !== current);
  return (
    <Block id="everywhere">
      <Heading
        title="One company, wherever you work."
        titleMuted="The same agents, files and sessions on every surface."
      />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4">
          {others.map((surface) => (
            <li key={surface.id} className="bg-background">
              <Link
                href={surface.href}
                className="group/cell outline-ring flex h-full flex-col gap-6 p-6 focus-visible:outline-2 focus-visible:-outline-offset-2 lg:p-8"
              >
                <span className="flex items-center justify-between">
                  <span className="text-foreground flex size-10 items-center justify-center rounded-md border">
                    <SurfaceMark id={surface.id} />
                  </span>
                  <ArrowRightIcon
                    aria-hidden
                    className={cn(
                      'text-muted-foreground size-4 transition-[translate,color] duration-moderate ease-out',
                      'group-hover/cell:text-foreground group-hover/cell:translate-x-0.5',
                    )}
                  />
                </span>
                <span className="flex flex-col gap-2">
                  <span className="text-foreground text-base font-medium">{surface.name}</span>
                  <span className="text-muted-foreground text-sm text-pretty">{surface.line}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Band>
    </Block>
  );
}

