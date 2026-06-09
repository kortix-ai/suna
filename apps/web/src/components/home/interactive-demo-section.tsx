'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Warp } from '@paper-design/shaders-react';
import { Blocks, MessageSquare } from 'lucide-react';
import { GoHomeFill } from 'react-icons/go';
import { HiMiniSparkles } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { PiChatCircleDotsFill, PiClockCountdownFill } from 'react-icons/pi';
import { RiCpuLine, RiRobot3Fill } from 'react-icons/ri';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { KortixLogo } from '../sidebar/kortix-logo';
import { AgentsPage } from './interactive-demo/pages/agents-page';
import { ChannelsPage } from './interactive-demo/pages/channels-page';
import { ChatPage } from './interactive-demo/pages/chat-page';
import { HomePage } from './interactive-demo/pages/home-page';
import { IntegrationsPage } from './interactive-demo/pages/integrations-page';
import { ModelsPage } from './interactive-demo/pages/models-page';
import { SchedulingPage } from './interactive-demo/pages/scheduling-page';
import { SecurityPage } from './interactive-demo/pages/security-page';
import { SkillsPage } from './interactive-demo/pages/skills-page';
import {
  useDemoConversation,
  type DemoConversation,
} from './interactive-demo/chat/use-demo-conversation';
import type { Nav, PageId } from './interactive-demo/types';

const PAGES: Record<
  PageId,
  {
    label: string;
    icon: React.ReactNode;
    render: (nav: Nav, convo: DemoConversation) => React.ReactNode;
  }
> = {
  home: {
    label: 'Home',
    icon: <GoHomeFill className="size-4" />,
    render: (nav, convo) => <HomePage nav={nav} convo={convo} />,
  },
  chat: {
    label: 'Chat',
    icon: <PiChatCircleDotsFill className="size-4" />,
    render: (_nav, convo) => <ChatPage convo={convo} />,
  },
  agents: {
    label: 'Agents',
    icon: <RiRobot3Fill className="size-4" />,
    render: () => <AgentsPage />,
  },
  skills: {
    label: 'Skills',
    icon: <HiMiniSparkles className="size-4" />,
    render: () => <SkillsPage />,
  },
  integrations: {
    label: 'Integrations',
    icon: <Blocks className="size-4" />,
    render: () => <IntegrationsPage />,
  },
  models: { label: 'Models', icon: <RiCpuLine className="size-4" />, render: () => <ModelsPage /> },
  scheduling: {
    label: 'Scheduling',
    icon: <PiClockCountdownFill className="size-4" />,
    render: () => <SchedulingPage />,
  },
  channels: {
    label: 'Channels',
    icon: <MessageSquare className="size-4" />,
    render: () => <ChannelsPage />,
  },
  security: {
    label: 'Security',
    icon: <MdShield className="size-4" />,
    render: () => <SecurityPage />,
  },
};

const ORDER: PageId[] = [
  'home',
  'chat',
  'agents',
  'skills',
  'integrations',
  'models',
  'scheduling',
  'channels',
  'security',
];

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

/* ─── Top bar (browser chrome) ──────────────────────────────────────────── */

function TopBar({ label, embedded }: { label: string; embedded: boolean }) {
  return (
    <div
      className={cn(
        'border-border/60 bg-background dark:bg-primary/7 flex shrink-0 items-center gap-3 border-b px-4',
        embedded ? 'h-9 px-3' : 'h-12',
      )}
    >
      <Breadcrumb className="ml-2 min-w-0">
        <BreadcrumbList className="text-sm">
          <BreadcrumbItem>
            <BreadcrumbPage className="text-foreground font-medium">
              <span className="inline-flex items-center gap-1.5">
                <KortixLogo size={12} />
                kortix
              </span>
            </BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-muted-foreground/40 [&>svg]:size-3" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="text-muted-foreground truncate font-normal">
              {label}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}

/* ─── Main ──────────────────────────────────────────────────────────────── */

export function InteractiveDemoSection({
  gradientbg = true,
  embedded = false,
  className,
  contentClassName,
}: {
  gradientbg?: boolean;
  /** Fills a fixed-aspect parent (e.g. homepage screen carousel) without min-height blowout. */
  embedded?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  const [active, setActive] = useState<PageId>('home');
  const convo = useDemoConversation({ onEnterChat: () => setActive('chat') });
  const page = PAGES[active];
  const tabRefs = useRef<Partial<Record<PageId, HTMLButtonElement>>>({});

  // Keep the active tab in view on small screens (the tab strip scrolls).
  useEffect(() => {
    tabRefs.current[active]?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
  }, [active]);

  // Deep-link from the navbar Product menu via the URL hash (e.g. /#agents).
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace('#', '');
      if (h && (ORDER as string[]).includes(h)) {
        setActive(h as PageId);
        requestAnimationFrame(() =>
          document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  return (
    <div
      className={cn(
        'relative mx-auto w-full max-w-6xl',
        embedded && 'h-full max-w-none',
        className,
      )}
    >
      <div
        className={cn(
          'relative -mx-1.5 overflow-hidden rounded p-4 sm:mx-0 sm:rounded-sm md:p-8 lg:p-10',
          embedded && 'mx-0 h-full p-0',
          contentClassName,
        )}
      >
        {gradientbg && (
          <div className="absolute inset-0">
            <Warp
              speed={4.3}
              scale={0.9}
              softness={1.5}
              proportion={0.64}
              swirl={0.86}
              swirlIterations={7}
              shape="edge"
              distortion={0.2}
              shapeScale={0.6}
              colors={['#A7E58B', '#324472', '#0A180D']}
              style={{ height: '100%', width: '100%' }}
            />
          </div>
        )}

        <div className={cn('relative z-10', embedded && 'h-full')}>
          <div
            className={cn(
              'bg-border dark:bg-background w-full rounded-xl p-1 sm:rounded-md',
              embedded && 'flex h-full flex-col',
            )}
          >
            {/* Scalloped feature tabs */}
            <div className="shadow-custom flex w-full [scrollbar-width:none] items-center gap-0.5 overflow-hidden overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {ORDER.map((id, index) => {
                const { label, icon: Icon } = PAGES[id];
                const isActive = id === active;
                return (
                  <button
                    key={id}
                    ref={(el) => {
                      if (el) tabRefs.current[id] = el;
                      else delete tabRefs.current[id];
                    }}
                    aria-label={label}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'text-foreground hit-area-3 flex shrink-0 cursor-pointer items-center justify-center transition-colors duration-150 ease-out',
                      !isActive ? 'gap-2 rounded-full px-3.5 py-0 [&>svg]:size-4' : '',
                    )}
                    type="button"
                    onClick={() => setActive(id)}
                  >
                    {isActive ? (
                      <span className="relative flex items-stretch">
                        {index !== 0 && <TabScallopEdge side="left" />}
                        <span
                          className={cn(
                            'bg-background dark:bg-primary/7 relative z-10 flex items-center gap-2 rounded-t-xl px-3.5 py-1 [&>svg]:size-4',
                          )}
                        >
                          {Icon}
                          {label}
                        </span>
                        {index !== ORDER.length - 1 && <TabScallopEdge side="right" />}
                      </span>
                    ) : (
                      <>
                        {Icon}
                        {label}
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            {/* App panel */}
            <div
              className={cn(
                'bg-background w-full overflow-hidden rounded-b-xl sm:rounded-b-[calc(var(--radius-xl)-4px)]',
                embedded && 'flex min-h-0 flex-1 flex-col',
              )}
            >
              <TopBar label={page.label} embedded={embedded} />

              <div
                className={cn(
                  '[&::-webkit-scrollbar-thumb]:bg-border w-full overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full',
                  embedded
                    ? 'h-full min-h-0 flex-1 p-3'
                    : 'max-h-120 min-h-[460px] p-5 sm:p-6 lg:h-[540px] lg:max-h-fit',
                )}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={active}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                    className="h-full w-full"
                  >
                    {page.render(setActive, convo)}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
