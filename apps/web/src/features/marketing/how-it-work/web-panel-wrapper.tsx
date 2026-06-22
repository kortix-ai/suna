'use client';

import type { PageId } from '@/components/home/interactive-demo/types';
import { cn } from '@/lib/utils';
import { Component as Blocks, Sparkles as Brain, GitPullRequest, Message as MessageSquare, Sparkles as HiMiniSparkles, Shield as MdShield, ChatDots as PiChatCircleDotsFill, Microchip as RiCpuLine, Folder as RiFolder3Fill, Sparkles as RiRobot3Fill } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

type MarketingPanelTab = PageId | 'review' | 'memory';

const DEMO_PANEL_TABS: Record<MarketingPanelTab, { label: string; icon: ReactNode }> = {
  home: { label: 'Home', icon: null },
  projects: { label: 'Projects', icon: <RiFolder3Fill className="size-4" /> },
  chat: { label: 'Chat', icon: <PiChatCircleDotsFill className="size-4" /> },
  agents: { label: 'Agents', icon: <RiRobot3Fill className="size-4" /> },
  skills: { label: 'Skills', icon: <HiMiniSparkles className="size-4" /> },
  integrations: { label: 'Integrations', icon: <Blocks className="size-4" /> },
  models: { label: 'Models', icon: <RiCpuLine className="size-4" /> },
  scheduling: { label: 'Scheduling', icon: null },
  channels: { label: 'Channels', icon: <MessageSquare className="size-4" /> },
  security: { label: 'Security', icon: <MdShield className="size-4" /> },
  review: { label: 'Review', icon: <GitPullRequest className="size-4" /> },
  memory: { label: 'Memory', icon: <Brain className="size-4" /> },
};

function TabScallopEdge({ side }: { side: 'left' | 'right' }) {
  const path = side === 'right' ? 'M0 0C0 32 16 64 38 64L0 64Z' : 'M38 0C38 32 22 64 0 64L38 64Z';
  return (
    <svg
      viewBox="0 0 38 64"
      fill="none"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-background dark:text-primary/7 mt-auto h-full w-3.5 shrink-0 self-stretch overflow-visible"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

export function WebPanelWrapper({
  activeTab,
  children,
  className,
}: {
  activeTab: MarketingPanelTab;
  children: ReactNode;
  className?: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tab = DEMO_PANEL_TABS[activeTab];

  return (
    <div className={cn('flex h-full flex-1 flex-col', className)}>
      <div className="bg-border dark:bg-background flex h-full w-full flex-col rounded-xl p-1">
        <div className="shadow-custom flex w-full items-center justify-between gap-0.5 overflow-hidden">
          <span
            aria-current="page"
            className="text-foreground hit-area-3 relative flex shrink-0 items-stretch"
          >
            <span className="bg-background dark:bg-primary/7 relative z-10 flex items-center gap-2 rounded-t-xl px-3.5 py-1 [&>svg]:size-4">
              {tab.icon}
              {tab.label}
            </span>
            <TabScallopEdge side="right" />
          </span>

          {activeTab === 'memory' && (
            <span className="text-kortix-green mr-3 text-xs font-medium">
              {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkWebPanelWrapperJsxTexte9d63c73')}
            </span>
          )}
        </div>

        <div
          className={cn(
            'bg-background dark:bg-primary/7 flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-b-xl sm:rounded-b-[calc(var(--radius-xl)-4px)]',
            // activeTab === 'projects'
            'rounded-tr-xl sm:rounded-tr-[calc(var(--radius-xl)-4px)]',
            // : 'rounded-t-xl sm:rounded-t-[calc(var(--radius-xl)-4px)]',
          )}
        >
          <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
