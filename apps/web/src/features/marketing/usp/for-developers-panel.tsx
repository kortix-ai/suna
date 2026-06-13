'use client';

import { Button } from '@/components/ui/marketing/button';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { Check, Copy, GitBranch } from 'lucide-react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { FOR_DEVELOPERS, type AuthorType, type Commit } from './section3-content';

const { commits } = FOR_DEVELOPERS;

const FEED_LEN = 6;
const TICK_MS = 2400;
const ENTER_EASE = [0.16, 1, 0.3, 1] as const;
const LAYOUT_SPRING = { type: 'spring', stiffness: 380, damping: 34 } as const;
const HEX = 'abcdef0123456789';

type AuthorStyle = { text: string; dot: string; flash: string };

function authorStyle(type: AuthorType): AuthorStyle {
  switch (type) {
    case 'human':
      return {
        text: 'text-muted-foreground',
        dot: 'border-kortix-base bg-card border-2',
        flash: 'bg-foreground/5',
      };
    case 'web':
      return {
        text: 'text-kortix-blue',
        dot: '  bg-card border-2 border-kortix-blue',
        flash: 'bg-kortix-blue/6',
      };
    case 'agent':
      return {
        text: 'text-kortix-purple',
        dot: 'bg-card border-2 border-kortix-purple',
        flash: 'bg-kortix-purple/6',
      };
    case 'merge':
      return {
        text: 'text-kortix-green',
        dot: 'bg-card border-2 border-kortix-green',
        flash: 'bg-kortix-green/8',
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

type FeedItem = Commit & { key: number; fresh: boolean };

/** Hash decodes from random hex into place — the terminal "materialize" moment. */
function ScrambleText({ value }: { value: string }) {
  const [display, setDisplay] = useState(() =>
    value.replace(/./g, () => HEX[Math.floor(Math.random() * HEX.length)]!),
  );

  useEffect(() => {
    let frame = 0;
    const total = 12;
    const id = setInterval(() => {
      frame += 1;
      if (frame >= total) {
        setDisplay(value);
        clearInterval(id);
        return;
      }
      const revealed = Math.ceil((frame / total) * value.length);
      let out = value.slice(0, revealed);
      for (let i = revealed; i < value.length; i++) {
        out += HEX[Math.floor(Math.random() * HEX.length)];
      }
      setDisplay(out);
    }, 45);
    return () => clearInterval(id);
  }, [value]);

  return <>{display}</>;
}

/** The git-graph rail: a continuous line with the commit node punched through it. */
function CommitRail({ dot, isMerge, fresh }: { dot: string; isMerge: boolean; fresh: boolean }) {
  return (
    <div className="relative flex w-5 shrink-0 flex-col items-center self-stretch">
      <span className="bg-border w-px flex-1" aria-hidden />
      <motion.span
        className="relative z-10 block size-3"
        initial={fresh ? { scale: 0 } : false}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 480, damping: 22, delay: 0.1 }}
      >
        <span
          className={cn(
            'ring-card relative flex size-3 shrink-0 items-center justify-center rounded-full',
            isMerge ? 'border-kortix-green bg-card border-2' : dot,
          )}
        />
      </motion.span>
      <span className="bg-border w-px flex-1" aria-hidden />
    </div>
  );
}

function CommitRow({ commit, fresh = false }: { commit: Commit; fresh?: boolean }) {
  const { text, dot, flash } = authorStyle(commit.authorType);
  const isMerge = commit.authorType === 'merge';

  /** Inner choreography: author line, then message, cascading after the node pops. */
  const reveal = (delay: number) =>
    fresh
      ? {
          initial: { opacity: 0, x: -10 },
          animate: { opacity: 1, x: 0 },
          transition: { duration: 0.4, delay, ease: ENTER_EASE },
        }
      : {};

  return (
    <div
      className={cn(
        'duration-moderate relative flex gap-3 px-4 transition-colors ease-out',
        isMerge ? 'bg-kortix-green/4 hover:bg-kortix-green/8' : 'hover:bg-muted/40',
      )}
    >
      <CommitRail dot={dot} isMerge={isMerge} fresh={fresh} />
      <div className="min-w-0 flex-1 py-3">
        <motion.div className="flex items-center gap-1" {...reveal(0.12)}>
          <span className={cn('truncate font-mono text-xs font-medium', text)}>
            {commit.author}
          </span>
          <span className="text-muted-foreground/50 ml-auto shrink-0 font-mono text-xs">
            {fresh ? <ScrambleText value={commit.hash} /> : commit.hash}
          </span>
        </motion.div>
        <motion.div
          className="text-muted-foreground mt-1 truncate font-mono text-xs"
          {...reveal(0.2)}
        >
          {commit.message}
        </motion.div>
      </div>
    </div>
  );
}

const DEFAULT_INSTALL_HOST = 'kortix.com';

function CloneBox() {
  const { copied, copy } = useCopy();
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);

  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

  return (
    <div className="border-border bg-background flex h-10 items-center gap-2 rounded-md border px-3 pr-1">
      <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
        <span className="text-foreground min-w-0 truncate font-mono text-xs select-all">
          {installCmd}
        </span>
      </div>
      <Button size="icon-sm" variant="ghost" onClick={() => copy(installCmd)}>
        {copied ? (
          <Check className="text-kortix-green size-4" />
        ) : (
          <Copy className="text-muted-foreground size-4" />
        )}
      </Button>
    </div>
  );
}

function LiveFeed() {
  const [feed, setFeed] = useState<FeedItem[]>(() =>
    commits.slice(0, FEED_LEN).map((c, i) => ({ ...c, key: i, fresh: false })),
  );
  const cursor = useRef(FEED_LEN);
  const nextKey = useRef(FEED_LEN);
  const containerRef = useRef<HTMLDivElement>(null);
  /** The ticker waits until the panel is actually seen, then the feed comes alive. */
  const inView = useInView(containerRef, { once: true, amount: 0.3 });
  const paused = useRef(false);

  useEffect(() => {
    if (!inView) return;
    const id = setInterval(() => {
      if (paused.current) return;
      const commit = commits[cursor.current % commits.length];
      cursor.current += 1;
      const item: FeedItem = { ...commit, key: nextKey.current++, fresh: true };
      setFeed((prev) => [item, ...prev].slice(0, FEED_LEN));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [inView]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-hidden py-2"
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
    >
      <div className="flex flex-col mask-t-from-10%">
        <AnimatePresence>
          {feed.map((item, index) => (
            <motion.div
              key={item.key}
              layout
              initial={
                item.fresh
                  ? { opacity: 0, y: -14, filter: 'blur(6px)' }
                  : { opacity: 0, y: 14, filter: 'blur(3px)' }
              }
              animate={
                item.fresh || inView
                  ? { opacity: 1, y: 0, filter: 'blur(0px)' }
                  : { opacity: 0, y: 14, filter: 'blur(3px)' }
              }
              transition={{
                duration: 0.5,
                ease: ENTER_EASE,
                delay: item.fresh ? 0 : 0.07 * index,
                layout: LAYOUT_SPRING,
              }}
            >
              <CommitRow commit={item} fresh={item.fresh} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StaticFeed() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col">
        {commits.map((commit) => (
          <CommitRow key={commit.hash + commit.message} commit={commit} />
        ))}
      </div>
    </div>
  );
}

export function ForDevelopersPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-border bg-card grid w-full lg:grid-cols-12">
      <div className="flex flex-col gap-6 border-r p-8 lg:col-span-4">
        <div className="space-y-3">
          <h2 className="text-foreground text-2xl font-medium tracking-tight">{title}</h2>
          <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{description}</p>
        </div>
        <CloneBox />
      </div>
      <div className="flex h-[460px] min-w-0 flex-col overflow-hidden lg:col-span-8">
        <div className="border-border/60 bg-muted/20 flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <div className="bg-foreground flex items-center gap-2 rounded px-2 py-1">
            <GitBranch className="text-background size-3.5 shrink-0" />
            <span className="text-background font-mono text-xs">main</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex size-1.5">
              <span className="bg-kortix-green/60 absolute inline-flex size-full animate-ping rounded-full" />
              <span className="bg-kortix-green relative inline-flex size-1.5 rounded-full" />
            </span>
            <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
              live
            </span>
          </div>
        </div>

        <StaticFeed />
      </div>
    </div>
  );
}
