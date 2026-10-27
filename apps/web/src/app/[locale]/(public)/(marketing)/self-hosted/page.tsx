import Link from '@/components/site-link';
import { CodePanel } from '@/features/marketing/code-panel';
import { splitTitle } from '@/features/marketing/kit/blocks';
import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { CodeTabs } from '@/features/marketing/kit/code-tabs';
import { DitherGlyph } from '@/features/marketing/kit/dither-glyph';
import { ExchangeVisual } from '@/features/marketing/kit/exchange-visual';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { SpecPanel } from '@/features/marketing/kit/spec-panel';
import { Band, Block, Heading, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import { getLocalizedSelfHostedContent } from '@/features/marketing/self-hosted/content';
import {
  commandsSummary,
  firstRunSummary,
  heroSub,
  modelsSummary,
  paritySummary,
  stackSummary,
  targetsSummary,
  yoursSummary,
} from '@/features/marketing/self-hosted/summary';
import { getTranslations } from '@/i18n/get-translations';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import type { ReactNode } from 'react';

/**
 * `/self-hosted`: run the whole thing on your own box.
 *
 * Every claim comes from `features/marketing/self-hosted/content.ts`, whose
 * header lists the facts corrected against the shipped CLI (the first-run
 * wizard does NOT ask for GitHub or a model key; air-gapped is not what
 * `kortix self-host start` gives you; there is no Redis). The page shows the
 * condensed form in `summary.ts`; the hero, the commands and the provider
 * shell come from `content.ts` directly.
 *
 * Layout matches /security: the landing page's frame, `FeatureSplit`
 * sections (title left, short copy right, one-line cells), a split layout
 * where a visual earns it, and dither art in the hero. The closing call to
 * action is the footer's.
 */

/** A section title: two sentences split into ink and muted, else the muted line from content. */
function twoTone(section: { title: string; titleMuted?: string }) {
  const [title, muted] = splitTitle(section.title);
  return { title, titleMuted: muted ?? section.titleMuted };
}

export default async function SelfHostedPage(): Promise<ReactNode> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const { commands, hero, models, targets } = getLocalizedSelfHostedContent(tI18nComplete);

  return (
    <PageFrame>
      {/* Hero with the server art, then the four facts the page proves. */}
      <section id="hero">
        <PageHero
          {...twoTone(hero)}
          sub={heroSub}
          aside={<DitherGlyph src="/media/self-hosted/server.svg" className="aspect-[12/11] w-80 xl:w-88" />}
          actions={
            <>
              <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </MarketingButton>
            </>
          }
        />
        <Band>
          <SpecGrid items={hero.specs} cols="lg:grid-cols-4" />
        </Band>
      </section>

      <FeatureSplit
        id="what-you-keep"
        {...yoursSummary}
        layout="split"
        visual={
          <ExchangeVisual
            cards={[
              {
                // The full-colour logo (several fills), so an image, not a one-colour mask.
                mark: <Image src="/media/self-hosted/postgresql.svg" alt="" width={24} height={24} unoptimized />,
                markPlain: true,
                title: 'Postgres',
                detail: 'A directory on your disk',
                tag: 'your box',
              },
              {
                mark: <FolderSimpleIcon weight="fill" className="size-5" />,
                title: 'File storage',
                detail: 'A second directory next to it',
                tag: 'your box',
              },
              {
                mark: 'kortix',
                title: 'Agent sandboxes',
                detail: 'On the provider you configure',
                tag: 'provider',
              },
            ]}
          />
        }
      />

      {/* The commands: one line each, the shell on the right. */}
      <Block id="commands">
        <Heading title={commandsSummary.title} titleMuted={commandsSummary.titleMuted} sub={commandsSummary.sub} />
        <Band className="mt-12">
          <CodeTabs
            label="Commands"
            tabs={[
              { id: 'install', ...commandsSummary.install, panel: { ...commands.install, lang: 'sh' } },
              { id: 'hosts', ...commandsSummary.hosts, panel: { ...commands.hosts, lang: 'sh' } },
            ]}
          />
        </Band>
      </Block>

      <FeatureSplit id="first-run" {...firstRunSummary} cols="lg:grid-cols-3" />

      <FeatureSplit
        id="stack"
        {...stackSummary}
        layout="split"
        visual={
          <ExchangeVisual
            cards={[
              { mark: 'kortix', title: 'kortix-api', detail: 'The API and the in-process LLM gateway', tag: 'kortix' },
              {
                mark: <BrandGlyph slug="supabase" />,
                markPlain: true,
                title: 'supabase-db',
                detail: 'Postgres, on a directory you control',
                tag: 'data',
              },
              { mark: 'kortix', title: 'kortix-updater', detail: 'Nightly pull, migrate, then swap', tag: 'kortix' },
            ]}
          />
        }
      />

      <FeatureSplit id="parity" {...paritySummary} />

      <FeatureSplit
        id="models"
        {...modelsSummary}
        layout="split"
        visual={
          <div className="flex h-full items-center p-4 sm:p-8 lg:p-12">
            <CodePanel title={models.shell.title} lines={models.shell.lines} lang="sh" className="w-full" />
          </div>
        }
      />

      {/* Where it runs on the left; what a production box needs, as a spec
          sheet, on the right. */}
      <FeatureSplit
        id="targets"
        {...targetsSummary}
        layout="split"
        visual={
          <div className="flex h-full items-center p-4 sm:p-8 lg:p-12">
            <SpecPanel title="what it wants" rows={targets.sizing.items} className="w-full" />
          </div>
        }
      />
    </PageFrame>
  );
}
