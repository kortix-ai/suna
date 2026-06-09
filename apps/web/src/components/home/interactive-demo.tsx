'use client';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Warp } from '@paper-design/shaders-react';
import {
  Blocks,
  Bot,
  ChevronRight,
  Clock,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { GoHomeFill } from 'react-icons/go';
import { HiMiniSparkles } from 'react-icons/hi2';
import type { IconType } from 'react-icons/lib';
import { MdShield } from 'react-icons/md';
import { PiChatCircleDotsFill, PiClockCountdownFill } from 'react-icons/pi';
import { RiCpuLine, RiRobot3Fill } from 'react-icons/ri';
import { KortixLogo } from '../sidebar/kortix-logo';
import { Composer } from './interactive-demo/chat/composer';
import { AUTO_DEMO_PROMPT } from './interactive-demo/chat/scenarios';
import {
  useDemoConversation,
  type DemoConversation,
} from './interactive-demo/chat/use-demo-conversation';
import { AgentsPage } from './interactive-demo/pages/agents-page';
import { ChannelsPage } from './interactive-demo/pages/channels-page';
import { ChatPage } from './interactive-demo/pages/chat-page';
import { IntegrationsPage } from './interactive-demo/pages/integrations-page';
import { ModelsPage } from './interactive-demo/pages/models-page';
import { SchedulingPage } from './interactive-demo/pages/scheduling-page';
import { SecurityPage } from './interactive-demo/pages/security-page';
import { SkillsPage } from './interactive-demo/pages/skills-page';
import type { Nav, PageId } from './interactive-demo/types';

type PageIcon = LucideIcon | IconType;

const RAIL_ICON = 'size-[1.05rem] lg:size-[1.2rem]';
const TAB_ICON = 'size-4';

type DemoExtras = {
  focusedSkill: string | null;
  onSkillClick: (name: string) => void;
};

const PAGES: Record<
  PageId,
  {
    label: string;
    Icon: PageIcon;
    context: string;
    render: (nav: Nav, convo: DemoConversation, extras: DemoExtras) => React.ReactNode;
  }
> = {
  home: {
    label: 'Home',
    Icon: GoHomeFill,
    context:
      'Your company\u2019s home base \u2014 start a task or pick up where your agents left off.',
    render: (nav, convo) => <HomePage nav={nav} convo={convo} />,
  },
  chat: {
    label: 'Chat',
    Icon: PiChatCircleDotsFill,
    context: 'Ask in plain language and watch an agent do the real work across your tools.',
    render: (_nav, convo, extras) => (
      <ChatPage convo={convo} onSkillClick={extras.onSkillClick} />
    ),
  },
  agents: {
    label: 'Agents',
    Icon: RiRobot3Fill,
    context: 'Each agent is its own worker \u2014 defined in .kortix/opencode/agents.',
    render: () => <AgentsPage />,
  },
  skills: {
    label: 'Skills',
    Icon: HiMiniSparkles,
    context: 'Package how your company does a job once \u2014 every agent can reuse it.',
    render: (_nav, _convo, extras) => <SkillsPage focusedSkill={extras.focusedSkill} />,
  },
  integrations: {
    label: 'Integrations',
    Icon: Blocks,
    context: '3,000+ tools, connected once and shared securely across the org.',
    render: () => <IntegrationsPage />,
  },
  models: {
    label: 'Models',
    Icon: RiCpuLine,
    context: 'Bring any provider \u2014 routed per session, keys stay in Secrets.',
    render: () => <ModelsPage />,
  },
  scheduling: {
    label: 'Scheduling',
    Icon: PiClockCountdownFill,
    context:
      'Put work on a schedule \u2014 briefings, reports, and routines that just happen, 24/7.',
    render: () => <SchedulingPage />,
  },
  channels: {
    label: 'Channels',
    Icon: MessageSquare,
    context: 'Run this project from chat \u2014 connect Slack and your agent responds in-thread.',
    render: () => <ChannelsPage />,
  },
  security: {
    label: 'Security',
    Icon: MdShield,
    context:
      'Roles, an encrypted secrets vault and per-tool permissions \u2014 with a full audit trail.',
    render: () => <SecurityPage />,
  },
};

function SendGlyph({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
    </svg>
  );
}

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
      className="text-background mt-auto h-full w-3.5 shrink-0 translate-y-px self-stretch overflow-visible"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

function HomePage({ nav, convo }: { nav: Nav; convo: DemoConversation }) {
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
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center">
        <div className="mt-4 flex w-full shrink-0 flex-col items-start justify-start space-y-6">
          <KortixLogo size={24} variant="logomark" />

          <div>
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
                    <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                      {sub}
                    </span>
                  </span>
                  <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-4 shrink-0 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-auto w-full">
          <Composer
            variant="home"
            value={convo.draft}
            onChange={convo.setDraft}
            onSubmit={() => convo.submit()}
            onPromptPick={convo.submit}
            disabled={busy}
          />
        </div>
      </div>
    </div>
  );
}

export function InteractiveDemo({
  gradientbg = true,
  tab = true,
  embedded = false,
  className,
  contentClassName,
  innerClassName,
  aside = true,
  parentClassName,
  activePage,
}: {
  gradientbg?: boolean;
  tab?: boolean;
  /** Fills a fixed-aspect parent (e.g. homepage screen carousel) without min-height blowout. */
  embedded?: boolean;
  className?: string;
  contentClassName?: string;
  innerClassName?: string;
  aside?: boolean;
  parentClassName?: string;
  activePage?: PageId;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [active, setActive] = useState<PageId>(activePage || 'home');
  const [focusedSkill, setFocusedSkill] = useState<string | null>(null);
  const convo = useDemoConversation({ onEnterChat: () => setActive('chat') });
  const rootRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  const page = PAGES[active];

  const handleSkillClick = useCallback((name: string) => {
    setFocusedSkill(name);
    setActive('skills');
  }, []);

  useEffect(() => {
    if (active !== 'skills') setFocusedSkill(null);
  }, [active]);
  const tabRefs = useRef<Partial<Record<PageId, HTMLButtonElement>>>({});
  const mobileTabRefs = useRef<Partial<Record<PageId, HTMLButtonElement>>>({});

  useEffect(() => {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;
    mobileTabRefs.current[active]?.scrollIntoView({
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

  // Auto-play once when the demo scrolls into view. Home-start surfaces type a
  // default prompt then submit; chat-first embeds stream it directly. Any real
  // interaction cancels it.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const startPage = activePage ?? 'home';
    const hash = window.location.hash.replace('#', '');
    if (
      startPage === 'home' &&
      hash &&
      hash !== 'demo' &&
      hash !== 'home' &&
      (ORDER as string[]).includes(hash)
    )
      return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !autoStarted.current) {
          autoStarted.current = true;
          io.disconnect();
          if (startPage === 'chat') convo.submit(AUTO_DEMO_PROMPT);
          else convo.startAutoDemo(AUTO_DEMO_PROMPT);
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative mx-auto w-full max-w-6xl space-y-8',
        embedded && 'mx-0 h-full max-w-none space-y-0',
        className,
      )}
    >
      <div
        className={cn(
          'relative -mx-1.5 overflow-hidden p-4 sm:mx-0 md:p-8 lg:p-10',
          embedded && 'mx-0 h-full p-0',
          contentClassName,
          aside && 'rounded sm:rounded-sm',
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

            <span
              className="absolute inset-0 bg-white mix-blend-color will-change-[clip-path,opacity]"
              style={{ clipPath: 'inset(0px calc(100% - 600px) 0px 0px)', opacity: 0 }}
            ></span>
          </div>
        )}

        <div className={cn('relative z-10', embedded && 'h-full')}>
          <div
            className={cn(
              'border-border bg-background overflow-hidden',
              embedded && 'flex h-full flex-col',
              innerClassName,
              aside && 'rounded sm:rounded-sm',
            )}
          >
            {/* <div
              className={cn(
                'border-border/60 bg-muted/30 flex shrink-0 items-center gap-3 px-4',
                embedded ? 'h-9 px-3' : 'h-12',
                'border-b',
              )}
            >
              <div className="flex gap-1.5">
                <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
                <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
                <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
              </div>

              <div className="ml-auto flex items-center gap-2">
                <span
                  className={cn(
                    'hidden h-8 w-44 items-center gap-2 rounded-md border px-3 text-xs md:flex',
                    'bg-secondary text-secondary-foreground border-border',
                  )}
                >
                  <Search className="size-3.5" /> Search
                </span>
                <span
                  className={cn(
                    'border-border text-muted-foreground flex size-8 items-center justify-center rounded-full border',
                    'bg-card text-card-foreground border-border',
                  )}
                >
                  <Bell className="size-4" />
                </span>
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-md border p-1 text-sm',
                    'bg-card text-card-foreground border-border',
                  )}
                >
                  {tHardcodedUi.raw('componentsHomeInteractiveDemo.line539JsxTextSarahAcmeAi')}
                </span>
              </div>
            </div>

            <div
              className={cn(
                'grid min-h-0 w-full grid-cols-1',
                aside
                  ? 'lg:h-[540px] lg:grid-cols-[30px_1fr]'
                  : 'bg-background h-full rounded-t-md lg:h-full lg:grid-cols-1',
                embedded && 'h-full flex-1 rounded-t-md',
                parentClassName,
              )}
            >
              {aside && (
                <aside className="border-border/60 bg-muted/20 hidden flex-col border-r p-3 lg:flex">
                  <div className="bg-foreground text-background border-border mb-1 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium">
                    <Plus className="size-4" />
                  </div>
                  <div className="text-muted-foreground mb-3 flex items-center gap-2.5 rounded-md p-1.5 px-2.5 text-sm">
                    <Search className="size-4" /> Search
                  </div>

                  <nav className="flex flex-col gap-0.5">
                    {ORDER.map((id) => {
                      const { label, Icon } = PAGES[id];
                      return (
                        <button
                          key={id}
                          onClick={() => setActive(id)}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                            id === active
                              ? 'bg-foreground/[0.07] text-foreground font-medium'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <Icon className={TAB_ICON} />
                        </button>
                      );
                    })}
                  </nav>

                  <div className="hover:bg-foreground/[0.07] mt-auto flex items-center gap-2.5 rounded-md p-1.5 px-2.5">
                    <UserAvatar
                      email={tHardcodedUi.raw(
                        'componentsHomeInteractiveDemo.line583JsxAttrEmailSarahAcmeAi',
                      )}
                      name="Sarah Chen"
                      size="md"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-xs font-medium">
                        {tHardcodedUi.raw('componentsHomeInteractiveDemo.line585JsxTextSarahChen')}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">Owner</span>
                    </span>
                  </div>
                </aside>
              )}

              <div
                className={cn(
                  '[&::-webkit-scrollbar-thumb]:bg-border w-full overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full',
                  parentClassName,
                  embedded
                    ? 'h-full min-h-0 overflow-hidden p-3'
                    : 'min-h-[460px] p-5 sm:p-6 lg:h-[540px]',
                  !aside && 'h-full p-5 sm:p-6 lg:h-full',
                )}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={active}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                    className="h-full w-full"
                  >
                    {page.render(setActive, convo, { focusedSkill, onSkillClick: handleSkillClick })}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div> */}

            <div className="border-card bg-card relative z-2 col-span-6 flex h-[min(72vh,520px)] w-full min-w-0 flex-1 flex-row items-center justify-center gap-1 rounded-[calc(var(--radius)+2px)] border-4 p-0.5 shadow-sm sm:h-[min(80vw,480px)] md:aspect-video md:h-full md:pl-0 lg:min-h-0">
              <div className="bg-background/90 border-card absolute top-2.5 left-2.5 z-10 flex size-11 items-center justify-center rounded-md border md:hidden">
                <KortixLogo size={20} />
              </div>
              <div className="hidden h-full min-h-0 w-8 shrink-0 flex-col items-center justify-start gap-3 py-2 md:flex lg:w-10 lg:gap-5">
                <KortixLogo size={20} />

                {ORDER.map((id) => {
                  const { label, Icon } = PAGES[id];
                  const isActive = id === active;

                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={label}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActive(id)}
                      className={cn(
                        'hit-area-x-4 hit-area-y-2.5 flex size-5 shrink-0 cursor-pointer items-center justify-center transition-colors',
                        isActive ? 'text-foreground' : 'text-foreground/50 hover:text-foreground',
                      )}
                    >
                      <Icon className={RAIL_ICON} />
                    </button>
                  );
                })}
              </div>
              <div className="bg-background flex h-full min-h-0 flex-1 flex-col items-end justify-end overflow-hidden rounded-md p-2.5 pt-10 sm:p-3 md:p-4 md:pt-4">
                <div className="flex min-h-0 w-full flex-1 flex-col justify-end space-y-2 overflow-y-auto sm:space-y-3 md:space-y-4">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={active}
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -8 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="h-full w-full"
                    >
                      {page.render(setActive, convo, { focusedSkill, onSkillClick: handleSkillClick })}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {tab && (
        <>
          <div className="hidden lg:block">
            <div className="mx-auto w-full max-w-full [scrollbar-width:none] overflow-x-auto scroll-smooth [-ms-overflow-style:none] lg:w-auto lg:overflow-visible [&::-webkit-scrollbar]:hidden">
              <div className="bg-border dark:bg-card mx-auto w-max rounded-xl p-1">
                <div className="shadow-custom flex w-max items-center gap-0.5 rounded-full">
                  {ORDER.map((id, index) => {
                    const { label, Icon } = PAGES[id];
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
                          !isActive ? 'gap-2 rounded-full px-3.5 py-0' : '',
                          index !== 0 && 'rounded-tl-none',
                          index !== ORDER.length - 1 && 'rounded-tr-none',
                        )}
                        type="button"
                        onClick={() => setActive(id)}
                      >
                        {isActive ? (
                          <span className="relative flex items-stretch">
                            {index !== 0 && <TabScallopEdge side="left" />}
                            <span className="bg-background relative z-10 flex items-center gap-2 rounded-t-xl px-3.5 py-1">
                              <Icon className={TAB_ICON} />
                              {label}
                            </span>
                            {index !== ORDER.length - 1 && <TabScallopEdge side="right" />}
                          </span>
                        ) : (
                          <>
                            <Icon className={TAB_ICON} />
                            {label}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div
                  className={cn(
                    'bg-background h-full w-full rounded-b-[calc(var(--radius-xl)-4px)]',

                    active !== 'home' && 'rounded-tl-[calc(var(--radius-xl)-4px)]',
                    active !== 'security' && 'rounded-tr-[calc(var(--radius-xl)-4px)]',
                  )}
                >
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={active}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="text-muted-foreground py-2 text-center text-sm leading-relaxed"
                    >
                      {page.context}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:hidden">
            <div className="mx-auto w-full max-w-full [scrollbar-width:none] overflow-x-auto scroll-smooth rounded-full [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              <div className="bg-foreground/10 shadow-custom mx-auto flex w-max items-center gap-0.5 rounded-full p-1">
                {ORDER.map((id) => {
                  const { label, Icon } = PAGES[id];
                  const isActive = id === active;
                  return (
                    <button
                      key={id}
                      ref={(el) => {
                        if (el) mobileTabRefs.current[id] = el;
                        else delete mobileTabRefs.current[id];
                      }}
                      aria-label={label}
                      aria-current={isActive ? 'page' : undefined}
                      className="text-foreground flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full px-3.5 py-2 transition-colors duration-150 ease-out"
                      type="button"
                      style={{
                        backgroundColor: isActive ? 'var(--background)' : 'transparent',
                      }}
                      onClick={() => setActive(id)}
                    >
                      <Icon className={TAB_ICON} />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <AnimatePresence mode="wait">
              <motion.p
                key={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: 'easeInOut' }}
                className="text-muted-foreground mx-auto mt-5 max-w-xl px-4 text-center text-sm leading-relaxed"
              >
                {page.context}
              </motion.p>
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}
