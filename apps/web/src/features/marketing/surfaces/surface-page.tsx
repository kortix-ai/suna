import Link from '@/components/site-link';
import { cn } from '@kortix/ui';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import { Fragment } from 'react';

import { MarketingButton } from '../kit/marketing-button';
import { Band, Heading, PageFrame } from '../kit/page-frame';
import { FaqSection } from '../landing-sections/faq-section';
import { SURFACE_ORDER, SURFACES, type SurfaceContent, type SurfaceId } from './content';
import { InlineCode } from './inline-code';
import { InstallCommand } from './install-command';
import { SURFACE_PANELS } from './panels';
import { SurfaceStage } from './stages';
import { SurfaceMark } from './surface-mark';
import { SurfaceTabs } from './surface-tabs';

/**
 * One template for the five "Use it from" pages: /desktop, /mobile, /cli,
 * /slack, /teams. The home page's rhythm, as /security uses it:
 *  1. Hero: a two-tone title, one sentence, the surface's call to action,
 *     then a band with one product-true visual of Kortix on that surface.
 *  2. Pillars: four cells, one idea each.
 *  3. How it works: one tab per capability, two sentences and one visual.
 *  4. The other surfaces, one cell each.
 *  5. FAQ: the home FaqSection.
 * Copy: content.ts. Hero visuals: stages.tsx. Tab visuals: panels.tsx.
 */
export function SurfacePage({ id }: { id: SurfaceId }) {
  const content = SURFACES[id];
  const panels = SURFACE_PANELS[id];
  return (
    <PageFrame>
      <Hero content={content} />
      <Pillars content={content} />
      <SurfaceTabs
        title={content.how.title}
        titleMuted={content.how.titleMuted}
        tabs={content.how.tabs}
        panels={content.how.tabs.map((tab) => {
          const Panel = panels[tab.id];
          return <Fragment key={tab.id}>{Panel ? <Panel /> : null}</Fragment>;
        })}
      />
      <OtherSurfaces current={id} />
      <FaqSection title="Questions." titleMuted="Answered from the code." items={content.faq} />
    </PageFrame>
  );
}

function Hero({ content }: { content: SurfaceContent }) {
  const { hero } = content;
  return (
    <section id="hero" className="relative">
      <div className="relative flex flex-col gap-7.5 px-8 pt-32 pb-18 lg:px-28 lg:pt-40">
        <div className="flex flex-col gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            {hero.sub}
          </p>
        </div>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-wrap items-center gap-2.5">
            {hero.install ? <InstallCommand /> : null}
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
          <p className="text-muted-foreground text-sm text-pretty">{hero.note}</p>
        </div>
      </div>

      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="bg-card flex flex-col items-center gap-7 overflow-hidden px-4 py-8 lg:gap-10 lg:px-11 lg:pt-17 lg:pb-10">
          <SurfaceStage id={content.id} />
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            {hero.caption} <span className="text-muted-foreground">{hero.captionMuted}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function Pillars({ content }: { content: SurfaceContent }) {
  const { pillars } = content;
  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={pillars.title} titleMuted={pillars.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          {pillars.items.map(({ icon: Icon, name, line, body }) => (
            <li key={name} className="bg-background flex flex-col gap-5 p-6 lg:p-10">
              <Icon className="text-foreground size-6" aria-hidden />
              <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                {name}
                <span className="text-muted-foreground mt-1 block text-lg leading-snug">
                  <InlineCode text={line} />
                </span>
              </h3>
              <p className="text-muted-foreground mt-auto text-base text-pretty">
                <InlineCode text={body} />
              </p>
            </li>
          ))}
        </ul>
      </Band>
    </section>
  );
}

/** The other places Kortix runs, one cell each. */
function OtherSurfaces({ current }: { current: SurfaceId }) {
  const others = SURFACE_ORDER.filter((s) => s.id !== current);
  return (
    <section id="everywhere" className="scroll-mt-16 py-14 lg:py-20">
      <Heading
        title="Use it from anywhere."
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
                      'text-muted-foreground duration-moderate size-4 transition-[translate,color] ease-out',
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
    </section>
  );
}
