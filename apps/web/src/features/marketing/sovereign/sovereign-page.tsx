'use client';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import Link from 'next/link';

import { data, files, hero, infra, lockIn, models, open } from './content';

// Facts: sovereign/content.ts (the accuracy gate lists every source).

/** Copy with `literal` segments: each backticked span renders in mono. */
function Literal({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 ? (
          <code key={i} className="font-mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function rows(items: readonly { id: string; k: string; v: string }[]) {
  return items.map((r) => ({ id: r.id, k: <Literal text={r.k} />, v: <Literal text={r.v} /> }));
}

/** What runs where, Kortix Cloud beside a self-hosted instance. */
function WhereItRuns() {
  return (
    <div className="bg-border grid grid-cols-1 gap-px">
      <div className="bg-background hidden grid-cols-3 gap-8 px-6 py-4 sm:grid lg:px-8">
        <span />
        {infra.columns.map((c) => (
          <span key={c} className="text-muted-foreground font-mono text-xs">
            {c}
          </span>
        ))}
      </div>
      {infra.where.map((row) => (
        <div key={row.id} className="bg-background grid grid-cols-1 gap-2 px-6 py-4 sm:grid-cols-3 sm:gap-8 lg:px-8">
          <span className="text-foreground text-sm font-medium">{row.k}</span>
          <span className="text-muted-foreground text-sm">
            <span className="font-mono text-xs sm:hidden">{infra.columns[0]}: </span>
            {row.cloud}
          </span>
          <span className="text-muted-foreground text-sm">
            <span className="font-mono text-xs sm:hidden">{infra.columns[1]}: </span>
            {row.self}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The starter project's files, as a tree. */
function ProjectTree() {
  return (
    <div className="bg-background flex min-w-0 flex-col">
      <p className="text-muted-foreground border-b px-4 py-3 font-mono text-xs lg:px-6">git repository</p>
      <pre className="text-foreground overflow-x-auto p-4 font-mono text-xs leading-relaxed lg:p-6">
        {files.tree.map((line) => (
          <div key={line.path} className="flex gap-6">
            <span className="w-48 shrink-0">{line.path}</span>
            <span className="text-muted-foreground">{line.note}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function Actions() {
  return (
    <>
      <MarketingButton size="md" className="hit-area-y-1" asChild>
        <Link href={hero.ctaPrimary.href}>{hero.ctaPrimary.label}</Link>
      </MarketingButton>
      <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
        <a href={hero.ctaSecondary.href} target="_blank" rel="noreferrer">
          {hero.ctaSecondary.label}
        </a>
      </MarketingButton>
    </>
  );
}

export function SovereignPage() {
  return (
    <PageFrame>
      <PageHero title={hero.title} titleMuted={hero.titleMuted} sub={hero.sub} actions={<Actions />} />

      <Block id="open-source">
        <Heading title={open.title} titleMuted={open.titleMuted} />
        <div className="mt-10">
          <KeyRows rows={rows(open.rows)} />
        </div>
      </Block>

      <Block id="infrastructure">
        <Heading
          title={infra.title}
          titleMuted={infra.titleMuted}
          sub={infra.sub}
          actions={
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <Link href={infra.docs.href}>{infra.docs.label}</Link>
            </MarketingButton>
          }
        />
        <Band className="mt-12">
          <WhereItRuns />
        </Band>
        <div className="mt-10">
          <KeyRows rows={rows(infra.rows)} />
        </div>
      </Block>

      <Block id="models">
        <Heading title={models.title} titleMuted={models.titleMuted} sub={models.sub} />
        <Band className="mt-12">
          <CellGrid items={models.items} cols="lg:grid-cols-4" />
        </Band>
      </Block>

      <Block id="files">
        <Heading title={files.title} titleMuted={files.titleMuted} />
        <Band className="mt-12">
          <ProjectTree />
        </Band>
        <div className="mt-10">
          <KeyRows rows={rows(files.rows)} />
        </div>
      </Block>

      <Block id="data">
        <Heading
          title={data.title}
          titleMuted={data.titleMuted}
          actions={
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <Link href={data.security.href}>{data.security.label}</Link>
            </MarketingButton>
          }
        />
        <Band className="mt-12">
          <CellGrid items={data.items} cols="lg:grid-cols-3" />
        </Band>
      </Block>

      <div className="pb-20 lg:pb-28">
        <Block id="no-lock-in">
          <Heading title={lockIn.title} titleMuted={lockIn.titleMuted} actions={<Actions />} />
          <Band className="mt-12">
            <SpecGrid items={lockIn.specs} cols="lg:grid-cols-4" />
          </Band>
        </Block>
      </div>
    </PageFrame>
  );
}
