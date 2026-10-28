'use client';

import { CopyRow, LinkRow } from '@/features/marketing/kit/copy-row';
import { Disclosure } from '@/features/marketing/kit/disclosure';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, Heading, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';
import { useState, type ReactNode } from 'react';
import { ApplyModal } from './apply-modal';
import { getLocalizedCareersContent } from './content';

type CareersContent = ReturnType<typeof getLocalizedCareersContent>;

/**
 * The board, in a band (after Linear's and Runway's open-roles lists on
 * Mobbin): one `Disclosure` row per opening with the role, its summary and the
 * two cities. `name` keeps one open at a time. Open, the bullets and the Apply
 * button sit under the summary. The role is a span, not a heading: a
 * `summary` may hold one heading alone or phrasing content, not both.
 */
function Board({
  hero,
  openings,
  apply,
  locations,
  onApply,
}: Pick<CareersContent, 'hero' | 'openings' | 'apply'> & { locations: string; onApply: () => void }): ReactNode {
  return (
    <Band>
      <div className="px-6 lg:px-11">
        {/* Column labels on the rows' grid; the empty cell stands in for the row's "+". */}
        <div aria-hidden className="text-muted-foreground hidden gap-6 border-b py-4 text-sm lg:flex">
          <span className="grid flex-1 grid-cols-12">
            <span className="col-span-4 pr-8">{hero.roleLabel}</span>
            <span className="col-span-6">{hero.summaryLabel}</span>
          </span>
          <span className="size-4 shrink-0" />
        </div>
        <div className="divide-y">
          {openings.map((opening) => (
            <Disclosure
              key={opening.id}
              name="openings"
              summary={
                <span className="grid grid-cols-1 items-baseline gap-y-2 lg:grid-cols-12">
                  <span className="text-xl font-medium tracking-tight text-balance lg:col-span-4 lg:pr-8">
                    {opening.name}
                  </span>
                  <span className="text-muted-foreground max-w-xl text-sm text-pretty lg:col-span-6 lg:pr-8">
                    {opening.summary}
                  </span>
                  <span className="text-muted-foreground text-sm lg:col-span-2 lg:text-right">{locations}</span>
                </span>
              }
            >
              <div className="pb-2 lg:grid lg:grid-cols-12 lg:pr-10">
                <div className="max-w-xl lg:col-span-6 lg:col-start-5">
                  <ul className="text-muted-foreground marker:text-muted-foreground list-disc space-y-2 pl-4 text-sm text-pretty">
                    {opening.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                  <MarketingButton size="md" className="hit-area-y-1 mt-8" onClick={onApply}>
                    {apply.cta}
                  </MarketingButton>
                </div>
              </div>
            </Disclosure>
          ))}
        </div>
      </div>
    </Band>
  );
}

/** The label each direct link row carries. */
const LINK_LABELS: Record<string, string> = { email: 'Email', x: 'X', linkedin: 'LinkedIn' };

/**
 * `/careers`: a board, not an essay. In the landing page's frame
 * (`kit/page-frame.tsx`) like /security and /about: the hero, the openings in
 * a band, the bar as hairline cells, and how to apply. Applications go
 * through `ApplyModal` into the same lead pipeline as "Book your demo". The
 * accuracy gate (locations, no invented comp) lives in `content.ts`.
 */
export function CareersPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { LOCATIONS, hero, openings, bar, apply } = getLocalizedCareersContent(tI18nComplete);
  const [applyOpen, setApplyOpen] = useState(false);
  const openApply = () => setApplyOpen(true);

  return (
    <PageFrame>
      <section id="openings" className="scroll-mt-16">
        <PageHero
          title={hero.title}
          titleMuted={hero.lead}
          sub={hero.description}
          actions={
            <>
              <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" onClick={openApply}>
                {hero.ctaPrimary}
              </MarketingButton>
            </>
          }
        />
        <Board hero={hero} openings={openings} apply={apply} locations={LOCATIONS} onApply={openApply} />
      </section>

      {/* The bar: seven cells, and the eighth is the way in. */}
      <Block id="what-we-look-for">
        <Heading title={bar.title} titleMuted={bar.titleMuted} sub={bar.lead} />
        <Band className="mt-12">
          <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4">
            {bar.items.map((item, i) => (
              <li key={item.id} className="bg-background flex flex-col gap-3 p-6 lg:p-8">
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-foreground text-base font-medium text-pretty">{item.title}</h3>
                <p className="text-muted-foreground text-sm text-pretty">{item.body}</p>
              </li>
            ))}
            <li className="bg-card flex flex-col justify-end gap-4 p-6 lg:p-8">
              <p className="text-foreground text-base font-medium text-pretty">{apply.titleMuted}</p>
              <MarketingButton size="md" className="hit-area-y-1 self-start" onClick={openApply}>
                {apply.cta}
              </MarketingButton>
            </li>
          </ul>
        </Band>
      </Block>

      {/* How to apply: the founder's note, then the direct lines as rows. */}
      <Block id="apply">
        <Heading
          title={apply.title}
          titleMuted={apply.titleMuted}
          sub={apply.body}
          actions={
            <MarketingButton size="md" className="hit-area-y-1" onClick={openApply}>
              {apply.cta}
            </MarketingButton>
          }
        />
        <Band className="mt-12">
          <div className="px-6 py-2 lg:px-11">
            <p className="text-muted-foreground border-b py-4 text-sm">{apply.directLead}</p>
            <ul className="divide-y">
              {apply.links.map((link) => (
                <li key={link.id}>
                  {link.external ? (
                    <LinkRow label={LINK_LABELS[link.id] ?? link.id} value={link.label} href={link.href} />
                  ) : (
                    <CopyRow label={LINK_LABELS[link.id] ?? link.id} value={link.label} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Band>
      </Block>

      <ApplyModal open={applyOpen} onOpenChange={setApplyOpen} />
    </PageFrame>
  );
}
