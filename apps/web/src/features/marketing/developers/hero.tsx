'use client';

import { HighlightedCode } from '@/components/markdown/code';
import SiteLink from '@/components/site-link';
import { Button } from '@/components/ui/marketing/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ARROW_RIGHT_GROUP_CLASS, ArrowRightIcon } from '@/features/icon/arrow-right';
import { Copy } from '@/features/icon/icons/copy';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useCopy } from '@/hooks/use-copy';
import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { DOCS_URL } from './content';
import { useDevelopersCopy } from './use-developers-copy';
import { DitherField } from './shared';

const STAGGER_MS = 60;

/** Fades and lifts its children in, `index` x 60ms after load. Final state under reduced motion. */
function Stagger({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <m.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: (index * STAGGER_MS) / 1000, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </m.div>
  );
}

/** File-window tab classes. */
const TAB_CLASS =
  'border-border shrink-0 cursor-pointer border-r px-3 py-3 font-mono text-xs transition-colors sm:px-4';
const tabState = (active: boolean) =>
  active ? 'text-foreground bg-background' : 'text-muted-foreground hover:text-foreground';

type Audience = 'humans' | 'agents';

function InstallRow({ audience }: { audience: Audience }) {
  const { hero } = useDevelopersCopy();
  const { copied, copy } = useCopy({ toast: false });
  const text = audience === 'humans' ? KORTIX_CLI_INSTALL_COMMAND : hero.agentInstruction;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-2 sm:flex-row">
      {/* Fixed one-line height: the command and the agent prompt render at the same size. */}
      <div className="border-border bg-card flex h-11 w-full min-w-0 shrink-0 items-center gap-3 rounded-lg border px-3 text-left sm:h-12 sm:w-auto sm:flex-1 sm:px-4">
        <code
          aria-live="polite"
          title={text}
          className="text-foreground min-w-0 flex-1 truncate font-mono text-xs tracking-normal select-all sm:text-sm"
        >
          {audience === 'humans' && <span className="select-none">$ </span>}
          {text}
        </code>
        <button
          type="button"
          aria-label={copied ? hero.copied : hero.copy}
          onClick={() => copy(text)}
          className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-colors"
        >
          {copied ? <SolidCheckIcon className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>
      <Button asChild size="lg" className={cn(ARROW_RIGHT_GROUP_CLASS, 'h-11 w-full shrink-0 px-5 sm:h-12 sm:w-auto')}>
        <SiteLink href={DOCS_URL}>
          {hero.docsCta}
          <ArrowRightIcon size={16} />
        </SiteLink>
      </Button>
    </div>
  );
}

function FileWindow() {
  const { hero } = useDevelopersCopy();
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const tab = hero.fileTabs[active];

  return (
    <div className="border-border bg-card w-full max-w-3xl overflow-hidden rounded-lg border text-left shadow-xl">
      <div className="border-border flex overflow-x-auto border-b">
        <div className="border-border flex shrink-0 items-center gap-1 border-r px-4" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="bg-border size-2 rounded-xs" />
          ))}
        </div>
        {hero.fileTabs.map((t, i) => (
          <button
            key={t.name}
            type="button"
            aria-pressed={active === i}
            onClick={() => setActive(i)}
            className={cn(TAB_CLASS, tabState(active === i))}
          >
            {t.name}
          </button>
        ))}
      </div>
      <m.div
        key={tab.name}
        tabIndex={0}
        role="region"
        aria-label={`${tab.name} ${hero.codeLabel}`}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="focus-visible:ring-ring min-h-64 overflow-x-auto px-4 py-4 font-mono text-xs sm:min-h-80 sm:px-6 sm:py-5 sm:text-sm focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        <HighlightedCode code={tab.code} language={tab.language} />
      </m.div>
    </div>
  );
}

export function DevelopersHero() {
  const { hero } = useDevelopersCopy();
  const [audience, setAudience] = useState<Audience>('humans');
  return (
    <section id="hero" className="relative w-full overflow-clip">
      {/* Decorative: behind the file window, fades out into the page background. */}
      <DitherField className="inset-x-0 top-auto bottom-0 h-3/5 mask-[radial-gradient(ellipse_at_center,black_35%,transparent_72%)] opacity-25" />
      <div className="relative mx-auto flex max-w-7xl flex-col items-center px-4 pt-28 pb-16 text-center sm:px-6 sm:pt-40 sm:pb-24 md:pt-52 md:pb-30">
        <Stagger index={0}>
          <Tabs value={audience} onValueChange={(v) => setAudience(v as Audience)}>
            <TabsList variant="segmented">
              <TabsTrigger value="humans">{hero.installTabs.humans}</TabsTrigger>
              <TabsTrigger value="agents">{hero.installTabs.agents}</TabsTrigger>
            </TabsList>
          </Tabs>
        </Stagger>
        <Stagger index={2} className="mt-6">
          <h1 className="text-foreground text-3xl/[1.1] font-medium tracking-tighter text-balance sm:text-4xl md:text-6xl">
            <span className="block">{hero.headline.muted}</span>
            <span className="block">{hero.headline.ink}</span>
          </h1>
        </Stagger>
        <Stagger index={3} className="mt-4 max-w-xl sm:mt-6">
          <p className="text-muted-foreground text-base text-balance sm:text-lg">{hero.description}</p>
        </Stagger>
        <Stagger index={4} className="mt-8 flex w-full justify-center sm:mt-10">
          <InstallRow audience={audience} />
        </Stagger>
        <Stagger index={5} className="mt-4 flex w-full justify-center sm:mt-6">
          <FileWindow />
        </Stagger>
      </div>
    </section>
  );
}
