'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Blocks, Bot, ChevronRight, Clock, MessageSquare, type LucideIcon } from 'lucide-react';
import { FaUsers } from 'react-icons/fa';
import { HiMiniSparkles } from 'react-icons/hi2';
import type { IconType } from 'react-icons/lib';
import { RiSettings3Fill } from 'react-icons/ri';
import { Composer } from '../chat/composer';
import type { DemoConversation } from '../chat/use-demo-conversation';
import { PageHead } from '../primitives';
import type { Nav, PageId } from '../types';

export function HomePage({ nav, convo }: { nav: Nav; convo: DemoConversation }) {
  const cards: [string, string, LucideIcon | IconType, string | undefined, PageId][] = [
    ['Integrations', 'Connect the tools your agents use', Blocks, '1', 'integrations'],
    ['Scheduled tasks', 'Run work on a schedule, 24/7', Clock, '2', 'scheduling'],
    ['Skills', 'Reusable workflows every agent shares', HiMiniSparkles, '71', 'skills'],
    ['Channels', 'Run this project from Slack', MessageSquare, undefined, 'channels'],
    ['Your team', 'Invite people to run and review', FaUsers, '2', 'security'],
    ['Agents', 'Shape how your agent thinks and acts', Bot, '3', 'agents'],
  ];
  const busy = convo.phase === 'thinking' || convo.phase === 'streaming';

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
        <div className="w-full">
          <Composer
            variant="home"
            value={convo.draft}
            onChange={convo.setDraft}
            onSubmit={convo.submit}
            disabled={busy}
          />
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
