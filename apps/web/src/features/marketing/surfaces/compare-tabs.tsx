'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@kortix/ui';
import { ArrowRightIcon, ChatCircleDotsIcon } from '@phosphor-icons/react';
import { useState } from 'react';

type Tab = { id: string; label: string; chatbot: string; kortix: string; artifact: string };

/**
 * "A chatbot answers. Kortix does the work." One task per tab; under it the
 * two outcomes side by side, split by an arrow: the chatbot's advice muted on
 * the left, Kortix's finished work in ink on the right, with what it produced.
 * The tabs swap content in place, instantly: this is reading, not a show.
 */
export function CompareTabs({ tabs }: { tabs: readonly Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!tab) return null;

  return (
    <div className="flex flex-col">
      <div role="tablist" aria-label="Tasks" className="bg-border grid grid-cols-1 gap-px sm:grid-cols-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab.id}
            onClick={() => setActive(t.id)}
            className={cn(
              'bg-background outline-ring px-6 py-4 text-left text-sm transition-colors duration-moderate ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 lg:px-8',
              t.id === tab.id ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="grid grid-cols-1 border-t md:grid-cols-[1fr_auto_1fr]">
        <div className="bg-card flex flex-col gap-10 p-6 lg:p-8">
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <ChatCircleDotsIcon aria-hidden className="size-4" />A chatbot
          </span>
          <p className="text-muted-foreground text-lg text-pretty">{tab.chatbot}</p>
        </div>
        <div className="text-muted-foreground hidden items-center border-x px-4 md:flex">
          <ArrowRightIcon aria-hidden className="size-4" />
        </div>
        <div className="bg-background flex flex-col gap-10 border-t p-6 md:border-t-0 lg:p-8">
          <span className="text-foreground flex items-center gap-2 text-sm font-medium">
            <KortixLogo size={14} variant="symbol" />
            Kortix
          </span>
          <div className="flex flex-col gap-4">
            <p className="text-foreground text-lg text-pretty">{tab.kortix}</p>
            <span className="text-muted-foreground w-fit rounded-sm border px-2.5 py-1 font-mono text-xs">
              {tab.artifact}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
