'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Blocks, Bot, ChevronRight, Clock, MessageSquare, Paperclip, type LucideIcon } from 'lucide-react';
import type { IconType } from 'react-icons/lib';
import { FaUsers } from 'react-icons/fa';
import { HiMiniSparkles } from 'react-icons/hi2';
import { RiMicAiFill, RiRobot3Fill, RiSettings3Fill } from 'react-icons/ri';
import { PageHead, SendGlyph } from '../primitives';
import type { Nav, PageId } from '../types';

const HOME_PROMPT_MESSAGES = [
  'Ask kortix to do anything across your company…',
  "Summarize this week's pipeline updates…",
  'Draft a reply to the Slack thread in #sales…',
  'What changed in our repos since Monday?',
  'Run the weekly finance report and email the team…',
] as const;

const HOME_PROMPT_CYCLE_MS = 4000;

function CyclingPromptText({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const interval = window.setInterval(() => {
      setIndex((i) => (i + 1) % HOME_PROMPT_MESSAGES.length);
    }, HOME_PROMPT_CYCLE_MS);
    return () => window.clearInterval(interval);
  }, [reduce]);

  if (reduce) {
    return <span className={className}>{HOME_PROMPT_MESSAGES[0]}</span>;
  }

  return (
    <div aria-live="polite" className={cn('relative overflow-hidden', className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={index}
          className="absolute inset-x-0 top-0 block"
          initial={{ opacity: 0, y: 8 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
          }}
          exit={{
            opacity: 0,
            y: -8,
            transition: { duration: 0.48, ease: [0.2, 0, 0.1, 1] },
          }}
        >
          {HOME_PROMPT_MESSAGES[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function HomePage({ nav }: { nav: Nav }) {
  const cards: [string, string, LucideIcon | IconType, string | undefined, PageId][] = [
    ['Integrations', 'Connect the tools your agents use', Blocks, '1', 'integrations'],
    ['Scheduled tasks', 'Run work on a schedule, 24/7', Clock, '2', 'scheduling'],
    ['Skills', 'Reusable workflows every agent shares', HiMiniSparkles, '71', 'skills'],
    ['Channels', 'Run this project from Slack', MessageSquare, undefined, 'channels'],
    ['Your team', 'Invite people to run and review', FaUsers, '2', 'security'],
    ['Agents', 'Shape how your agent thinks and acts', Bot, '3', 'agents'],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHead
        title="Good morning, Human"
        sub="Kortix · Enterprise workspace"
        action={
          <Button variant="default" size="sm">
            <RiSettings3Fill className="size-3.5" /> Customize
          </Button>
        }
      />

      <div className="flex min-h-0 w-full flex-1 flex-col items-start justify-start">
        <div className="border-border bg-card flex w-full flex-col rounded-md border p-3">
          <CyclingPromptText className="text-muted-foreground h-20 px-1 text-sm" />
          <div className="mt-auto flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground inline-flex size-7 items-center justify-center rounded-sm">
                <Paperclip className="size-3.5" />
              </span>
              <span className="text-foreground inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs">
                <RiRobot3Fill className="size-3.5" /> kortix
              </span>
              <span className="text-muted-foreground hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-xs sm:inline-flex">
                <Icon.Claude className="size-3.5" />
                Claude Opus 4.8
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground inline-flex size-7 items-center justify-center">
                <RiMicAiFill className="size-3.5" />
              </span>
              <span className="bg-foreground text-background inline-flex size-6 items-center justify-center rounded-sm">
                <SendGlyph />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 shrink-0">
        <div className="text-muted-foreground/70 mb-2 px-0.5 text-xs font-medium tracking-wider uppercase">
          Build out your project
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(([title, sub, Icon, count, target]) => (
            <button
              key={title}
              type="button"
              onClick={() => nav(target)}
              className="border-border/70 bg-card hover:border-border hover:bg-muted/30 group flex items-center gap-3 rounded-md border p-3 text-left transition-colors"
            >
              <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border">
                <Icon className="text-foreground/70 size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                  {title}
                  {count && (
                    <Badge size="sm" variant="muted">
                      {count}
                    </Badge>
                  )}
                </span>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs">{sub}</span>
              </span>
              <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-4 shrink-0 transition-colors" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
