import Link from '@/components/site-link';
import { CodePanel } from '@/features/marketing/code-panel';
import { splitTitle } from '@/features/marketing/kit/blocks';
import { CodeTabs } from '@/features/marketing/kit/code-tabs';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import { getLocalizedSelfHostedContent } from '@/features/marketing/self-hosted/content';
import { getTranslations } from '@/i18n/get-translations';
import type { ReactNode } from 'react';

/**
 * `/self-hosted`: run the whole thing on your own box.
 *
 * Copy lives in `features/marketing/self-hosted/content.ts`, and that file's
 * header lists the six claims this page corrects against the shipped CLI (the
 * first-run wizard does NOT ask for GitHub or a model key; air-gapped is not
 * what `kortix self-host start` gives you; there is no Redis). Read it before
 * editing a line here.
 *
 * Layout is the /security page's (`kit/page-frame.tsx`): a two-tone title and
 * one line of description per section, then a band of hairline cells, rows or
 * tabs. No eyebrows, no reveal motion, no closing section: the footer carries
 * the call to action.
 */

/** A section title: two sentences split into ink and muted, else the muted line from content. */
function twoTone(section: { title: string; titleMuted?: string }) {
  const [title, muted] = splitTitle(section.title);
  return { title, titleMuted: muted ?? section.titleMuted };
}

export default async function SelfHostedPage(): Promise<ReactNode> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const { commands, firstRun, hero, models, parity, stack, targets, yours } =
    getLocalizedSelfHostedContent(tI18nComplete);

  return (
    <PageFrame>
      {/* Hero: the four facts the rest of the page proves, as one row of cells. */}
      <section id="hero">
        <PageHero
          {...twoTone(hero)}
          sub={hero.sub}
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

      {/* 1 · What you keep: on your box, and what is not. */}
      <Block id="what-you-keep">
        <Heading {...twoTone(yours)} sub={yours.sub} />
        <Band className="mt-12">
          <div className="grid grid-cols-1 md:grid-cols-2">
            {[yours.onbox, yours.offbox].map((side, i) => (
              <div key={side.label} className={i === 0 ? 'p-6 lg:p-11' : 'border-t p-6 md:border-t-0 md:border-l lg:p-11'}>
                <h3 className="text-foreground text-base font-medium first-letter:uppercase">{side.label}</h3>
                <ul className="mt-4 divide-y">
                  {side.items.map((item) => (
                    <li
                      key={item}
                      className={
                        i === 0 ? 'text-foreground py-3.5 text-sm text-pretty' : 'text-muted-foreground py-3.5 text-sm text-pretty'
                      }
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Band>
        <p className="text-muted-foreground px-8 pt-6 text-sm text-pretty lg:px-28">{yours.offbox.note}</p>
      </Block>

      {/* 2 · The commands: start the stack, then choose the host. */}
      <Block id="commands">
        <Heading {...twoTone(commands)} sub={commands.sub} />
        <Band className="mt-12">
          <CodeTabs
            label="Commands"
            tabs={[
              { id: 'install', k: commands.install.title, v: commands.notes[1], panel: { ...commands.install, lang: 'sh' } },
              {
                id: 'hosts',
                k: commands.hosts.title,
                v: `${commands.notes[0]} ${commands.notes[2]}`,
                panel: { ...commands.hosts, lang: 'sh' },
              },
            ]}
          />
        </Band>
      </Block>

      {/* 3 · The first run: six questions, then what it generates. */}
      <Block id="first-run">
        <Heading {...twoTone(firstRun)} sub={firstRun.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-3"
            items={firstRun.asks.items.map((item) => ({ id: item.n, n: item.n, k: item.k, v: item.v }))}
          />
        </Band>
        <Band className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="p-6 lg:p-11">
              <h3 className="text-foreground text-base font-medium first-letter:uppercase">{firstRun.generates.label}</h3>
              <p className="text-muted-foreground mt-4 text-sm text-pretty">{firstRun.generates.note}</p>
            </div>
            <ul className="divide-y border-t p-6 md:border-t-0 md:border-l lg:p-11">
              {firstRun.generates.items.map((item) => (
                <li key={item} className="text-foreground py-3.5 text-sm text-pretty">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </Band>
        <p className="text-muted-foreground px-8 pt-6 text-sm text-pretty lg:px-28">{firstRun.after}</p>
      </Block>

      {/* 4 · The stack: every Compose service by group, then data and updates. */}
      <Block id="stack">
        <Heading {...twoTone(stack)} sub={stack.sub} />
        <Band className="mt-12">
          <div className="bg-border grid grid-cols-1 gap-px md:grid-cols-3">
            {stack.groups.map((group) => (
              <div key={group.id} className="bg-background p-6 lg:p-8">
                <h3 className="text-foreground text-base font-medium first-letter:uppercase">{group.label}</h3>
                <dl className="mt-4 divide-y">
                  {group.services.map((service) => (
                    <div key={service.k} className="py-3.5">
                      <dt className="text-foreground font-mono text-sm">{service.k}</dt>
                      <dd className="text-muted-foreground mt-1 text-sm text-pretty">{service.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Band>
        <div className="mt-6">
          <KeyRows rows={[stack.data, stack.updates].map((card) => ({ id: card.title, k: card.title, v: card.body }))} />
        </div>
      </Block>

      {/* 5 · Parity. */}
      <Block id="parity">
        <Heading {...twoTone(parity)} sub={parity.sub} />
        <div className="mt-6">
          <KeyRows rows={parity.rows} />
        </div>
      </Block>

      {/* 6 · Models: the two notes beside the shell that connects a provider. */}
      <Block id="models">
        <Heading {...twoTone(models)} sub={models.sub} />
        <Band className="mt-12">
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <ul className="flex flex-col gap-8 px-4 py-12 lg:px-11 lg:py-16 lg:pr-12">
              {models.points.map((point) => (
                <li key={point.id}>
                  <h3 className="text-foreground text-base font-medium text-pretty">{point.title}</h3>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">{point.body}</p>
                </li>
              ))}
            </ul>
            <div className="bg-card flex min-w-0 items-center border-t p-4 sm:p-8 lg:border-t-0 lg:border-l lg:p-12">
              <CodePanel title={models.shell.title} lines={models.shell.lines} lang="sh" className="w-full" />
            </div>
          </div>
        </Band>
      </Block>

      {/* 7 · Where it runs, then what it wants. */}
      <Block id="targets">
        <Heading {...twoTone(targets)} sub={targets.sub} />
        <Band className="mt-12">
          <CellGrid cols="lg:grid-cols-3" items={targets.rows} />
        </Band>
        <h3 className="text-foreground px-8 pt-12 text-base font-medium lg:px-28">{targets.sizing.label}</h3>
        <div className="mt-2">
          <KeyRows rows={targets.sizing.items} />
        </div>
      </Block>
    </PageFrame>
  );
}
