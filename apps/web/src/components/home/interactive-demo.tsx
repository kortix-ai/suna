'use client';

import { useTranslations } from 'next-intl';

import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Warp } from '@paper-design/shaders-react';
import {
  ArrowRight,
  Blocks,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileText,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { FaCircle, FaUsers } from 'react-icons/fa';
import { GoHomeFill } from 'react-icons/go';
import { HiMiniSparkles } from 'react-icons/hi2';
import { IconType } from 'react-icons/lib';
import { MdShield } from 'react-icons/md';
import { PiChatCircleDotsFill, PiCheckCircleFill, PiClockCountdownFill } from 'react-icons/pi';
import { RiCpuLine, RiMicAiFill, RiRobot3Fill, RiSettings3Fill } from 'react-icons/ri';
import { KortixLogo } from '../sidebar/kortix-logo';
import { Reveal } from './reveal';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

type PageId =
  | 'home'
  | 'chat'
  | 'agents'
  | 'skills'
  | 'integrations'
  | 'models'
  | 'scheduling'
  | 'channels'
  | 'security';

type Nav = (id: PageId) => void;

/* ─── Shared primitives ─────────────────────────────────────────────────── */

function PageHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-foreground text-lg font-semibold tracking-tight">{title}</h3>
        {sub && <p className="text-muted-foreground mt-0.5 text-sm">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function Panel({
  title,
  count,
  action,
  children,
  className,
}: {
  title?: string;
  count?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-md border', className)}>
      {title && (
        <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-foreground text-sm font-semibold">
            {title}
            {count && <span className="text-muted-foreground ml-1.5 font-normal">{count}</span>}
          </span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Row({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
}: {
  leading: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={cn(
        'border-border flex items-center gap-3 border-b px-4 py-3 last:border-0',
        onClick && 'hover:bg-muted/40 cursor-pointer transition-colors',
      )}
    >
      <span className="shrink-0">{leading}</span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="text-muted-foreground truncate text-xs">{subtitle}</div>}
      </div>
      {trailing}
    </div>
  );
}

/** Real brand logo (favicon) on a neutral tile — used for Integrations + Models. */
function BrandLogo({ domain, alt, size = 20 }: { domain: string; alt: string; size?: number }) {
  return (
    <span
      className="border-border bg-background flex shrink-0 items-center justify-center overflow-hidden rounded-lg border"
      style={{ width: size + 12, height: size + 12 }}
    >
      <img
        src={favicon(domain)}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        // className="rounded-sm"
        style={{ width: size, height: size }}
      />
    </span>
  );
}

function StatusDot({ on, label }: { on: boolean; label?: [string, string] }) {
  const [onText, offText] = label ?? ['running', 'scheduled'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        on ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          on ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/30',
        )}
      />
      {on ? onText : offText}
    </span>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick?: () => void }) {
  const className = cn(
    'flex h-5 w-9 items-center rounded-full p-0.5 transition-colors',
    on ? 'bg-kortix-green justify-end' : 'bg-muted-foreground/20 justify-start',
    onClick && 'cursor-pointer',
  );
  const knob = <span className="size-4 rounded-full bg-white shadow" />;
  if (!onClick) return <span className={className}>{knob}</span>;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Toggle schedule"
      onClick={onClick}
      className={className}
    >
      {knob}
    </button>
  );
}

function ConnectBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge size="sm" variant="success" className="ml-auto shrink-0 gap-1">
      <span className="size-1.5 rounded-full bg-emerald-500" /> Connected
    </Badge>
  ) : (
    <Badge size="sm" variant="outline" className="ml-auto shrink-0">
      Connect
    </Badge>
  );
}

/* ─── Home ───────────────────────────────────────────────────────────────── */

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

function HomePage({ nav }: { nav: Nav }) {
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

/* ─── Chat (kept — retheme to the kortix agent) ─────────────────────────── */

const CHAT_SEQUENCE_MS = [400, 600, 2400, 550, 750, 650, 650, 700, 1100];
const CHAT_STREAM_STEPS = 9;

function ChatPage() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState(reduce ? CHAT_STREAM_STEPS : 0);

  useEffect(() => {
    if (reduce) {
      setStage(CHAT_STREAM_STEPS);
      return;
    }
    setStage(0);
    const timers: number[] = [];
    let acc = 0;
    CHAT_SEQUENCE_MS.forEach((d, i) => {
      acc += d;
      timers.push(window.setTimeout(() => setStage(i + 1), acc));
    });
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reduce]);

  const steps = [
    'Pulled Q3 metrics from the data warehouse',
    'Drafted 12 slides from your board template',
    'Charted revenue, burn, and pipeline',
  ];
  const isDone = stage >= CHAT_STREAM_STEPS;

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex items-center gap-2 text-xs tracking-wide">
        <MessageSquare className="size-3.5" />
        sessions / q3-board-deck
      </div>

      <div className="flex-1 space-y-4 overflow-hidden">
        {stage >= 1 && (
          <Reveal className="bg-foreground text-background ml-auto w-fit max-w-[82%] rounded-md rounded-br-sm px-4 py-2.5 text-sm">
            Build the Q3 board deck from our latest financials.
          </Reveal>
        )}

        {stage >= 2 && (
          <Reveal>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-foreground flex items-center gap-2 text-sm font-medium">
                <RiRobot3Fill className="size-3.5" />
                kortix
              </span>
              <AnimatePresence mode="wait" initial={false}>
                {isDone ? (
                  <motion.span
                    key="done"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Badge size="sm" variant="badgeSuccess">
                      done
                    </Badge>
                  </motion.span>
                ) : (
                  <motion.span
                    key="working"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Badge size="sm" variant="secondary">
                      working
                    </Badge>
                  </motion.span>
                )}
              </AnimatePresence>
              <span className="text-muted-foreground ml-auto text-xs">14:32</span>
            </div>

            <AnimatePresence mode="wait">
              {stage === 2 && (
                <motion.div
                  key="reasoning"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.25 }}
                  className="flex items-center gap-1.5 py-0.5"
                >
                  <span className="relative flex size-2.5 shrink-0">
                    <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
                    <span className="bg-muted-foreground/50 relative inline-flex size-2.5 rounded-full" />
                  </span>
                  <AnimatedThinkingText
                    statusText="Reading the latest financials…"
                    className="text-muted-foreground text-xs"
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {stage >= 3 && (
              <Reveal className="border-border/60 bg-card overflow-hidden rounded-md border">
                <div className="border-border/60 bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs">
                  <Database className="text-muted-foreground size-3.5" />
                  <span className="text-foreground font-medium">query_warehouse</span>
                  {stage >= 4 ? (
                    <Check className="ml-auto size-3.5 text-emerald-500" />
                  ) : (
                    <span className="border-muted-foreground/40 border-t-foreground ml-auto size-3.5 animate-spin rounded-full border-[1.5px]" />
                  )}
                </div>
                <div className="text-muted-foreground space-y-1 px-3 py-2.5 font-mono text-xs leading-relaxed">
                  <div>
                    <span className="text-foreground">SELECT</span> revenue, burn, pipeline
                  </div>
                  {stage >= 4 && (
                    <motion.div
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      <span className="text-foreground">FROM</span> metrics.q3{' '}
                      <span className="text-emerald-500">— 312 rows</span>
                    </motion.div>
                  )}
                </div>
              </Reveal>
            )}

            {stage >= 5 && (
              <div className="mt-3 space-y-2 pl-1">
                {steps.map(
                  (s, i) =>
                    stage >= 5 + i && (
                      <Reveal key={s} className="flex items-center gap-2 text-sm">
                        <PiCheckCircleFill className="text-kortix-green size-3.5 shrink-0" />
                        <span className="text-muted-foreground">{s}</span>
                      </Reveal>
                    ),
                )}
                {stage >= 8 && (
                  <Reveal className="flex items-center gap-2 text-sm">
                    {isDone ? (
                      <PiCheckCircleFill className="text-kortix-green size-3.5 shrink-0" />
                    ) : (
                      <FaCircle className="text-muted-foreground size-3 shrink-0 animate-pulse" />
                    )}
                    <span className="text-foreground">Formatting &amp; final review</span>
                  </Reveal>
                )}
              </div>
            )}

            {stage >= 9 && (
              <Reveal className="border-border/60 bg-card mt-3 flex items-center gap-3 rounded-md border p-3">
                <span className="bg-foreground/6 text-foreground flex size-9 items-center justify-center rounded-lg">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Q3-board-deck.pptx</div>
                  <div className="text-muted-foreground text-xs">12 slides · ready in 4 min</div>
                </div>
                <span className="text-background/90 bg-primary/90 inline-flex size-8 items-center justify-center rounded-md border">
                  <Download className="size-4" />
                </span>
              </Reveal>
            )}
          </Reveal>
        )}
      </div>

      <div className="border-border bg-card mt-4 flex items-center gap-2 rounded-md border p-2.5">
        <Paperclip className="text-muted-foreground size-4" />
        <span className="text-muted-foreground flex-1 text-sm">Reply to kortix…</span>
        <span className="text-background bg-primary/90 inline-flex size-7 items-center justify-center rounded-md">
          <SendGlyph />
        </span>
      </div>
    </div>
  );
}

/* ─── Agents ────────────────────────────────────────────────────────────── */

type AgentDef = {
  name: string;
  desc: string;
  icon: LucideIcon | IconType;
  trigger: string;
  model: string;
  modelDomain: string;
  runs: string;
  last: string;
  on: boolean;
};

const AGENTS: AgentDef[] = [
  {
    name: 'kortix',
    desc: 'General knowledge worker — full tool access; codes, researches, writes and runs ops end-to-end in an isolated sandbox.',
    icon: Bot,
    trigger: 'primary',
    model: 'Claude Opus 4.8',
    modelDomain: 'anthropic.com',
    runs: '1,204',
    last: '4m ago',
    on: true,
  },
  {
    name: 'pr-bot',
    desc: 'Runs a thermo-nuclear review and stands up a one-click preview on every pull request to kortix-ai/kortix.',
    icon: GitPullRequest,
    trigger: 'webhook',
    model: 'GPT-5',
    modelDomain: 'openai.com',
    runs: '8,930',
    last: '12m ago',
    on: true,
  },
  {
    name: 'memory-reflector',
    desc: 'Reflects on recent activity and curates .kortix/memory, opening a memory CR each run.',
    icon: Brain,
    trigger: 'cron',
    model: 'Gemini 2.5 Flash',
    modelDomain: 'gemini.google.com',
    runs: '512',
    last: '2h ago',
    on: false,
  },
  {
    name: 'researcher',
    desc: 'Deep multi-source research with structured synthesis, inline citations and charts.',
    icon: Search,
    trigger: 'manual',
    model: 'Grok 4',
    modelDomain: 'x.ai',
    runs: '742',
    last: '1h ago',
    on: true,
  },
  {
    name: 'analyst',
    desc: 'Profiles the warehouse, writes performant SQL and ships a dashboard from a plain question.',
    icon: Database,
    trigger: 'manual',
    model: 'DeepSeek V3',
    modelDomain: 'deepseek.com',
    runs: '1,890',
    last: '26m ago',
    on: true,
  },
  {
    name: 'support-triage',
    desc: 'Categorizes, prioritizes and routes inbound tickets, drafting an empathetic first reply.',
    icon: MessageSquare,
    trigger: 'webhook',
    model: 'MiniMax M2',
    modelDomain: 'minimax.io',
    runs: '6,431',
    last: 'just now',
    on: true,
  },
  {
    name: 'deck-builder',
    desc: 'Turns a prompt and your latest data into board decks and polished presentations.',
    icon: FileText,
    trigger: 'manual',
    model: 'GLM-4.6',
    modelDomain: 'z.ai',
    runs: '318',
    last: '5h ago',
    on: false,
  },
  {
    name: 'sdr',
    desc: 'Enriches leads from the CRM, researches each account and drafts tailored outreach.',
    icon: FaUsers,
    trigger: 'manual',
    model: 'Qwen3 Max',
    modelDomain: 'qwen.ai',
    runs: '2,205',
    last: '38m ago',
    on: true,
  },
];

function AgentCard({ agent }: { agent: AgentDef }) {
  return (
    <div className="border-border/70 bg-card hover:border-border hover:bg-muted/20 flex flex-col rounded-md border p-3.5 transition-colors">
      <div className="flex items-start gap-3">
        <EntityAvatar icon={agent.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-semibold">{agent.name}</span>
            <Badge size="sm" variant="muted" className="font-mono">
              {agent.trigger}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">
            {agent.desc}
          </p>
        </div>
        <StatusDot on={agent.on} label={['active', 'idle']} />
      </div>
      <div className="border-border/60 mt-3 border-t pt-2.5">
        <InlineMeta>
          <span className="inline-flex items-center gap-1">
            <img
              src={favicon(agent.modelDomain)}
              alt=""
              width={12}
              height={12}
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
              className="size-3 shrink-0 rounded-sm"
            />
            {agent.model}
          </span>
          <span>{agent.runs} runs</span>
          <span>{agent.last}</span>
        </InlineMeta>
      </div>
    </div>
  );
}

function AgentsPage() {
  const running = AGENTS.filter((a) => a.on).length;
  const triggered = AGENTS.filter((a) => a.trigger !== 'manual' && a.trigger !== 'primary').length;
  const stats: [string, string][] = [
    [String(AGENTS.length), 'Agents'],
    [String(running), 'Running now'],
    ['22.2k', 'Runs · 7d'],
    [String(triggered), 'Auto-triggered'],
  ];
  return (
    <div>
      <PageHead
        title="Agents"
        sub="Each agent is its own worker — defined in .kortix/opencode/agents"
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New agent
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {stats.map(([n, l]) => (
          <div key={l} className="border-border/70 bg-card rounded-md border px-3 py-2.5">
            <div className="text-foreground text-lg font-semibold tracking-tight">{n}</div>
            <div className="text-muted-foreground mt-0.5 text-xs">{l}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        {AGENTS.map((a) => (
          <AgentCard key={a.name} agent={a} />
        ))}
      </div>
    </div>
  );
}

/* ─── Skills (all 71 real skills) ───────────────────────────────────────── */

const CORE_SKILLS: [string, string][] = [
  ['agent-browser', 'Browser automation CLI for AI agents'],
  ['kortix-executor', 'One interface to every connected integration'],
  ['kortix-memory', 'Read, write, and curate the project brain'],
  ['kortix-slack', 'Answer in Slack as a teammate'],
  ['kortix-system', 'Canonical reference for a Kortix project'],
  ['thermo-nuclear-review', 'Strict maintainability & abstraction review'],
];

const GKW_SKILLS: [string, string][] = [
  ['account-research', 'Full picture of any company or person before outreach'],
  ['audit-support', 'SOX 404 control testing, sampling & documentation'],
  ['brand-voice', 'Document, apply & enforce brand voice across content'],
  ['call-prep', 'Get fully prepared for any sales call in minutes'],
  ['campaign-planning', 'Plan, structure & execute marketing campaigns'],
  ['canned-responses', 'Response templates for an in-house legal team'],
  ['close-management', 'Month-end close checklist, sequencing & tracking'],
  ['coding-and-data', 'Routes coding, repo work, SQL & investigation'],
  ['competitive-analysis', 'Competitive analysis for product managers'],
  ['competitive-intelligence', 'Research competitors & generate an HTML battlecard'],
  ['compliance', 'Compliance assistant for an in-house legal team'],
  ['content-creation', 'Effective marketing content across channels'],
  ['contract-review', 'Contract review assistant for legal teams'],
  ['create-an-asset', 'Build prospect decks, one-pagers & demos'],
  ['customer-research', 'Multi-source research on customers & accounts'],
  ['daily-briefing', 'A clear view of what matters most today'],
  ['deep-research', 'Deep, multi-source research agent'],
  ['design-foundations', 'Artifact-agnostic design guidance for any output'],
  ['document-review', 'Structured review, fact-check & annotation'],
  ['docx', 'Create, edit, extract & review Word documents'],
  ['domain-research', 'Free domain research & availability checking'],
  ['draft-outreach', 'Research first, then draft outreach'],
  ['elevenlabs', 'Text-to-speech, voice cloning & sound effects'],
  ['escalation', 'Decide when and how to escalate support issues'],
  ['exploration', 'Profile datasets, assess quality & find patterns'],
  ['fastapi-sdk', 'Write FastAPI code with current best practices'],
  ['feature-spec', 'Write PRDs & feature specifications'],
  ['financial-statements', 'GAAP presentation, adjustments & flux analysis'],
  ['hyper-fast-youtube-transcript', 'Pull a YouTube transcript from a URL or ID'],
  ['journal-entry-prep', 'Standard entry types & review workflows'],
  ['knowledge-management', 'Create & maintain support knowledge content'],
  ['legal-writer', 'Draft contracts, memos, briefs & demand letters'],
  ['logo-creator', 'Create logos through an iterative design process'],
  ['media', 'Media commands run via bash (ffmpeg & more)'],
  ['meeting-briefing', 'Meeting prep assistant for legal teams'],
  ['metrics-tracking', 'Define, track & act on product metrics'],
  ['nda-triage', 'NDA screening assistant for legal teams'],
  ['openalex-paper-search', 'Academic search over 240M+ scholarly works'],
  ['paper-creator', 'Scientific paper writing in LaTeX to compiled PDF'],
  ['pdf', 'Create, edit, OCR, fill & convert PDFs'],
  ['performance-analytics', 'Measure & optimize marketing performance'],
  ['pptx', 'Create, edit & validate PowerPoint decks'],
  ['presentations', 'Build & export HTML slides (1920×1080)'],
  ['reconciliation', 'GL-to-subledger & bank reconciliation methodology'],
  ['remotion', 'Programmatic video creation in React'],
  ['replicate', 'Discover, compare & run AI models on Replicate'],
  ['research-assistant', 'Deep multi-source research with synthesis'],
  ['research-report', 'Markdown research reports with citations & charts'],
  ['response-drafting', 'Professional, empathetic customer-facing replies'],
  ['risk-assessment', 'Legal risk assessment assistant'],
  ['roadmap-management', 'Roadmap planning, prioritization & comms'],
  ['sql-queries', 'Correct, performant SQL across warehouse dialects'],
  ['stakeholder-comms', 'Status updates & stakeholder management'],
  ['statistical-analysis', 'Trend analysis, outliers & hypothesis testing'],
  ['theme-factory', 'Design themes for non-website assets'],
  ['ticket-triage', 'Categorize, prioritize & route support tickets'],
  ['user-research-synthesis', 'Turn raw research into structured insight'],
  ['validation', 'Pre-delivery QA checklist & sanity checks'],
  ['variance-analysis', 'Decompose variances with waterfall methodology'],
  ['visualization', 'Chart selection & Python visualization patterns'],
  ['webapp', 'Fullstack apps on the Express/Vite/React/Drizzle stack'],
  ['website-building', 'Production-grade sites & interactive experiences'],
  ['website-building-webapp', 'App-like experiences from the website template'],
  ['whisper', 'Transcribe audio & video with Whisper'],
  ['xlsx', 'Spreadsheets, financial models & polished workbooks'],
];

function SkillItem({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="border-border/60 bg-card hover:bg-muted/30 flex items-start gap-2.5 rounded-md border p-2.5 transition-colors">
      <span className="border-border bg-muted/40 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
        <HiMiniSparkles className="text-foreground/70 size-3" />
      </span>
      <div className="min-w-0">
        <div className="text-foreground truncate font-mono text-xs font-medium">{name}</div>
        <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-snug">{desc}</div>
      </div>
    </div>
  );
}

function SkillsPage() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const match = ([n, d]: [string, string]) =>
    !query || n.toLowerCase().includes(query) || d.toLowerCase().includes(query);
  const core = CORE_SKILLS.filter(match);
  const gkw = GKW_SKILLS.filter(match);
  const total = CORE_SKILLS.length + GKW_SKILLS.length;

  return (
    <div>
      <PageHead
        title="Skills"
        sub={`${total} skills · packaged once, reused by every agent`}
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New skill
          </Button>
        }
      />

      <div className="border-border bg-card mb-4 flex h-9 items-center gap-2 rounded-md border px-3">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search 71 skills…"
          className="placeholder:text-muted-foreground/60 text-foreground w-full bg-transparent text-sm outline-none"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            Clear
          </button>
        )}
      </div>

      {core.length > 0 && <SkillGroup label="Core" count={core.length} skills={core} />}
      {gkw.length > 0 && (
        <SkillGroup
          label="General Knowledge Worker"
          count={gkw.length}
          skills={gkw}
          className="mt-5"
        />
      )}
      {core.length === 0 && gkw.length === 0 && (
        <div className="text-muted-foreground py-10 text-center text-sm">
          No skills match “{q}”.
        </div>
      )}
    </div>
  );
}

function SkillGroup({
  label,
  count,
  skills,
  className,
}: {
  label: string;
  count: number;
  skills: [string, string][];
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className="text-foreground text-sm font-semibold">{label}</span>
        <Badge size="sm" variant="muted">
          {count}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {skills.map(([n, d]) => (
          <SkillItem key={n} name={n} desc={d} />
        ))}
      </div>
    </div>
  );
}

/* ─── Integrations (3,000+ via Pipedream) ───────────────────────────────── */

const INTEGRATIONS: [string, string, boolean][] = [
  ['github.com', 'GitHub', true],
  ['slack.com', 'Slack', true],
  ['gmail.com', 'Gmail', false],
  ['stripe.com', 'Stripe', false],
  ['notion.so', 'Notion', false],
  ['linear.app', 'Linear', false],
  ['hubspot.com', 'HubSpot', false],
  ['salesforce.com', 'Salesforce', false],
  ['drive.google.com', 'Google Drive', false],
  ['atlassian.com', 'Jira', false],
  ['figma.com', 'Figma', false],
  ['airtable.com', 'Airtable', false],
  ['shopify.com', 'Shopify', false],
  ['zoom.us', 'Zoom', false],
  ['asana.com', 'Asana', false],
  ['discord.com', 'Discord', false],
  ['twilio.com', 'Twilio', false],
  ['sendgrid.com', 'SendGrid', false],
  ['zendesk.com', 'Zendesk', false],
  ['intercom.com', 'Intercom', false],
  ['gitlab.com', 'GitLab', false],
  ['dropbox.com', 'Dropbox', false],
  ['calendly.com', 'Calendly', false],
  ['mailchimp.com', 'Mailchimp', false],
];

const CONNECTOR_TYPES = ['App', 'MCP', 'OpenAPI', 'GraphQL', 'HTTP'];

function IntegrationsPage() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const list = INTEGRATIONS.filter(
    ([domain, name]) =>
      !query || name.toLowerCase().includes(query) || domain.toLowerCase().includes(query),
  );
  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-lg font-semibold tracking-tight">Integrations</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">
            3,000+ apps · connected once, shared securely across the org
          </p>
        </div>

        <div className="flex items-center gap-2 sm:shrink-0">
          {/* <div className="border-border bg-card focus-within:ring-primary/40 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 focus-within:ring-2 sm:w-52 sm:flex-none">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps…"
              aria-label="Search apps"
              className="placeholder:text-muted-foreground/60 text-foreground w-full min-w-0 bg-transparent text-sm outline-none"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Clear search"
                className="text-muted-foreground/60 hover:text-foreground shrink-0 text-sm leading-none"
              >
                ✕
              </button>
            )}
          </div> */}
          <div className="border-border bg-card mb-4 flex h-9 items-center gap-2 rounded-md border px-3">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps…"
              className="placeholder:text-muted-foreground/60 text-foreground w-full bg-transparent text-sm outline-none"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {CONNECTOR_TYPES.map((t, i) => (
          <Badge
            key={t}
            // size="sm"
            variant={i === 0 ? 'highlight' : 'outline'}
            // className="font-mono"
          >
            {t}
          </Badge>
        ))}
        <span className="text-muted-foreground ml-1 text-xs">
          Pipedream, MCP, OpenAPI, GraphQL & raw HTTP — one Executor interface
        </span>
      </div>

      {list.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {list.map(([domain, name, connected]) => (
            <div
              key={name}
              className="border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5"
            >
              <BrandLogo domain={domain} alt={name} />
              <span className="text-foreground truncate text-sm font-medium">{name}</span>
              <ConnectBadge connected={connected} />
            </div>
          ))}
        </div>
      ) : (
        <div className="border-border/60 text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
          No featured app matches “{q}”.
        </div>
      )}

      <button className="border-border/60 bg-muted/20 hover:bg-muted/40 mt-2.5 flex w-full items-center justify-center gap-2 rounded-md border border-dashed py-3 text-sm transition-colors">
        <Blocks className="text-muted-foreground size-4" />
        <span className="text-foreground font-medium">
          {query ? `Search “${q}” across all 3,000+ apps` : 'Browse all 3,000+ apps'}
        </span>
        <ArrowRight className="text-muted-foreground size-3.5" />
      </button>
    </div>
  );
}

/* ─── Models (new — real provider catalog) ──────────────────────────────── */

type Provider = {
  domain: string | null;
  name: string;
  hint: string;
  state: 'managed' | 'connected' | 'connect';
};

const PROVIDERS: Provider[] = [
  {
    domain: null,
    name: 'Kortix Gateway',
    hint: 'Managed routing — injected into every sandbox',
    state: 'managed',
  },
  {
    domain: 'anthropic.com',
    name: 'Anthropic',
    hint: 'Claude — Opus, Sonnet, Haiku',
    state: 'connected',
  },
  { domain: 'openai.com', name: 'OpenAI', hint: 'GPT-5, GPT-4o, o-series', state: 'connect' },
  { domain: 'ai.google.dev', name: 'Google', hint: 'Gemini 2.5 Pro, Flash', state: 'connect' },
  {
    domain: 'groq.com',
    name: 'Groq',
    hint: 'Fast inference — Llama, Mixtral, Kimi',
    state: 'connect',
  },
  { domain: 'x.ai', name: 'xAI', hint: 'Grok', state: 'connect' },
  { domain: 'deepseek.com', name: 'DeepSeek', hint: 'DeepSeek V3, R1', state: 'connect' },
  { domain: 'mistral.ai', name: 'Mistral', hint: 'Mistral Large, Codestral', state: 'connect' },
  {
    domain: 'openrouter.ai',
    name: 'OpenRouter',
    hint: 'Routes across many providers',
    state: 'connect',
  },
  { domain: 'cerebras.ai', name: 'Cerebras', hint: 'Very fast — Llama, Qwen', state: 'connect' },
  { domain: 'together.ai', name: 'Together', hint: 'Open models hosted', state: 'connect' },
  { domain: 'fireworks.ai', name: 'Fireworks', hint: 'Open models hosted', state: 'connect' },
  { domain: 'perplexity.ai', name: 'Perplexity', hint: 'Web-grounded models', state: 'connect' },
  {
    domain: 'aws.amazon.com',
    name: 'Amazon Bedrock',
    hint: 'Claude, Llama, Titan',
    state: 'connect',
  },
  {
    domain: 'azure.microsoft.com',
    name: 'Azure OpenAI',
    hint: 'Azure-hosted OpenAI',
    state: 'connect',
  },
  { domain: 'cohere.com', name: 'Cohere', hint: 'Command R', state: 'connect' },
  { domain: 'huggingface.co', name: 'Hugging Face', hint: 'Inference endpoints', state: 'connect' },
  { domain: 'nvidia.com', name: 'NVIDIA NIM', hint: 'NIM microservices', state: 'connect' },
];

function ModelsPage() {
  return (
    <div>
      <PageHead
        title="Models"
        sub="Bring any provider — routed per session, keys stay in Secrets"
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> Add provider
          </Button>
        }
      />

      <div className="space-y-2">
        {PROVIDERS.map((p) => (
          <div
            key={p.name}
            className="border-border/60 bg-card flex items-center gap-3 rounded-md border p-2.5"
          >
            {p.domain ? (
              <BrandLogo domain={p.domain} alt={p.name} />
            ) : (
              <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-lg">
                <RiCpuLine className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm font-medium">{p.name}</div>
              <div className="text-muted-foreground truncate text-xs">{p.hint}</div>
            </div>
            {p.state === 'managed' ? (
              <Badge size="sm" variant="highlight" className="shrink-0 gap-1">
                <HiMiniSparkles className="size-3" /> Managed
              </Badge>
            ) : p.state === 'connected' ? (
              <ConnectBadge connected />
            ) : (
              <Button variant="outline" size="sm" className="shrink-0">
                <KeyRound className="size-3.5" /> Connect
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <KeyRound className="size-3.5 shrink-0" />
        Connecting a provider writes its API key to Secrets — sessions pick it up at sandbox boot.
      </div>
    </div>
  );
}

/* ─── Scheduling (cron triggers) ────────────────────────────────────────── */

type ScheduleJob = { name: string; cron: string; when: string; next: string; on: boolean };

const INITIAL_JOBS: ScheduleJob[] = [
  { name: 'memory-reflector', cron: '0 */6 * * *', when: 'every 6 hours', next: 'in 2h', on: true },
  { name: 'Daily briefing', cron: '0 8 * * *', when: 'every day · 08:00', next: 'in 6h', on: true },
  {
    name: 'Weekly PR digest',
    cron: '0 7 * * 1',
    when: 'every Mon · 07:00',
    next: 'in 3d',
    on: true,
  },
  {
    name: 'Quarterly cleanup',
    cron: '0 6 1 */3 *',
    when: 'every 90 days',
    next: 'in 21d',
    on: false,
  },
];

function SchedulingPage() {
  const [jobs, setJobs] = useState<ScheduleJob[]>(INITIAL_JOBS);
  const toggle = (name: string) =>
    setJobs((js) => js.map((j) => (j.name === name ? { ...j, on: !j.on } : j)));
  const activeCount = jobs.filter((j) => j.on).length;

  return (
    <div>
      <PageHead
        title="Scheduling"
        sub={`${activeCount} active · cron triggers in your timezone, running 24/7`}
        action={
          <Button size="sm">
            <Plus className="size-3.5" /> New schedule
          </Button>
        }
      />
      <Panel>
        {jobs.map((job) => (
          <Row
            key={job.name}
            leading={
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg border transition-colors',
                  job.on
                    ? 'border-kortix-green/20 bg-kortix-green/10 text-kortix-green'
                    : 'border-border bg-background text-muted-foreground',
                )}
              >
                <Clock className="size-4" />
              </span>
            }
            title={job.name}
            subtitle={
              <InlineMeta>
                <span className="font-mono">{job.cron}</span>
                <span>{job.when}</span>
                <span>{job.on ? `next ${job.next}` : 'paused'}</span>
              </InlineMeta>
            }
            trailing={<Toggle on={job.on} onClick={() => toggle(job.name)} />}
          />
        ))}
      </Panel>
    </div>
  );
}

/* ─── Channels (Slack — mirrors the real customize surface) ─────────────── */

function ChannelsPage() {
  const [showByo, setShowByo] = useState(false);
  return (
    <div>
      <PageHead
        title="Channels"
        sub="Run this project from chat — connect a Slack workspace and your agent responds in the channels you invite it to."
      />

      <div className="border-border bg-card overflow-hidden rounded-md border">
        <div className="flex flex-col items-start gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="border-border flex size-14 shrink-0 items-center justify-center rounded-lg border">
              <Icon.Slack className="size-7" />
            </span>
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                Add Kortix to your Slack workspace
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                One click — approve scopes in Slack and we&apos;ll wire this project to the
                workspace you choose. Tokens stay encrypted in this project&apos;s secrets.
              </p>
            </div>
          </div>
          <Button size="sm" className="shrink-0">
            <Icon.Slack className="size-3.5" /> Add to Slack
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setShowByo((v) => !v)}
          className="border-border hover:bg-muted/30 flex w-full items-center justify-between gap-3 border-t px-4 py-3 text-left transition-colors"
          aria-expanded={showByo}
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">Bring your own Slack app</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              For self-hosted setups or custom-scoped installs.
            </p>
          </div>
          <ChevronDown
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform',
              showByo && 'rotate-180',
            )}
          />
        </button>
        {showByo && (
          <div className="border-border text-muted-foreground border-t px-4 py-3 text-xs">
            Paste a Slack app manifest and your Bot User OAuth Token + Signing Secret — stored
            encrypted in <span className="text-foreground font-mono">project_secrets</span>.
          </div>
        )}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <MessageSquare className="size-3.5 shrink-0" />
        Invite the bot to any channel and{' '}
        <span className="text-foreground font-mono">@mention</span> it — a session spawns and the
        agent replies in-thread.
      </div>
    </div>
  );
}

/* ─── Security (members + secrets vault) ────────────────────────────────── */

type Member = { email: string; name: string; role: 'Owner' | 'Admin' | 'Member'; last: string };
type Secret = { name: string; masked: string; domain: string; rotated: string; agents: number };
type Policy = { domain: string; name: string; allow: number; ask: number; block: number };

const MEMBERS: Member[] = [
  { email: 'marko@kortix.com', name: 'marko', role: 'Owner', last: 'active now' },
  { email: 'dom@kortix.com', name: 'Dom Williams', role: 'Admin', last: '2h ago' },
  { email: 'sara@kortix.com', name: 'Sara Khan', role: 'Member', last: '1d ago' },
];

const SECRETS: Secret[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    masked: 'sk-ant-••••4f2a',
    domain: 'anthropic.com',
    rotated: '12d ago',
    agents: 6,
  },
  {
    name: 'OPENAI_API_KEY',
    masked: 'sk-••••9c10',
    domain: 'openai.com',
    rotated: '30d ago',
    agents: 3,
  },
  {
    name: 'SLACK_BOT_TOKEN',
    masked: 'xoxb-••••7d3',
    domain: 'slack.com',
    rotated: '8d ago',
    agents: 2,
  },
  {
    name: 'GITHUB_TOKEN',
    masked: 'ghp_••••2b8e',
    domain: 'github.com',
    rotated: '3d ago',
    agents: 1,
  },
  {
    name: 'STRIPE_API_KEY',
    masked: 'sk_live_••••a91c',
    domain: 'stripe.com',
    rotated: '45d ago',
    agents: 1,
  },
];

const POLICIES: Policy[] = [
  { domain: 'github.com', name: 'GitHub', allow: 14, ask: 3, block: 1 },
  { domain: 'slack.com', name: 'Slack', allow: 9, ask: 1, block: 0 },
  { domain: 'stripe.com', name: 'Stripe', allow: 4, ask: 6, block: 2 },
];

function PolicyRow({ policy }: { policy: Policy }) {
  const total = policy.allow + policy.ask + policy.block;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="border-border flex items-center gap-3 border-b px-4 py-3 last:border-0">
      <BrandLogo domain={policy.domain} alt={policy.name} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground text-sm font-medium">{policy.name}</span>
          <span className="text-muted-foreground text-xs">{total} tools</span>
        </div>
        <div className="bg-muted mt-2 flex h-1.5 overflow-hidden rounded-full">
          <span className="bg-kortix-green" style={{ width: pct(policy.allow) }} />
          <span className="bg-amber-500" style={{ width: pct(policy.ask) }} />
          {policy.block > 0 && (
            <span className="bg-destructive" style={{ width: pct(policy.block) }} />
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-xs font-medium">
          <span className="text-emerald-600 dark:text-emerald-500">{policy.allow} allow</span>
          <span className="text-amber-600 dark:text-amber-500">{policy.ask} ask</span>
          <span className={policy.block > 0 ? 'text-destructive' : 'text-muted-foreground/50'}>
            {policy.block} block
          </span>
        </div>
      </div>
    </div>
  );
}

function SecurityPage() {
  const stats: [string, string][] = [
    [String(MEMBERS.length), 'Members'],
    [String(SECRETS.length), 'Secrets'],
    ['41', 'Tool policies'],
    ['128', 'Audit events · 24h'],
  ];
  return (
    <div>
      <PageHead
        title="Security & access"
        sub="Roles, an encrypted secrets vault and per-tool permissions — with a full audit trail"
      />

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {stats.map(([n, l]) => (
            <div key={l} className="border-border/70 bg-card rounded-md border px-3 py-2.5">
              <div className="text-foreground text-lg font-semibold tracking-tight">{n}</div>
              <div className="text-muted-foreground mt-0.5 text-xs">{l}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Members & roles"
            count="· 3"
            action={
              <Button variant="outline" size="sm">
                <Plus className="size-3.5" /> Invite
              </Button>
            }
          >
            {MEMBERS.map((m) => (
              <Row
                key={m.email}
                leading={<UserAvatar email={m.email} name={m.name} size="sm" />}
                title={m.name}
                subtitle={
                  <InlineMeta>
                    <span>{m.email}</span>
                    <span>{m.last}</span>
                  </InlineMeta>
                }
                trailing={
                  <div className="flex items-center gap-2">
                    <span
                      className="hidden items-center gap-1 text-xs text-emerald-600 sm:flex dark:text-emerald-500"
                      title="Two-factor enabled"
                    >
                      <MdShield className="size-3.5" /> 2FA
                    </span>
                    <Badge size="sm" variant={m.role === 'Owner' ? 'highlight' : 'outline'}>
                      {m.role}
                    </Badge>
                  </div>
                }
              />
            ))}
          </Panel>

          <Panel title="Secrets vault" count="· 5 encrypted">
            {SECRETS.map((sec) => (
              <Row
                key={sec.name}
                leading={<BrandLogo domain={sec.domain} alt={sec.name} size={16} />}
                title={<span className="font-mono text-xs">{sec.name}</span>}
                subtitle={
                  <InlineMeta>
                    <span className="font-mono">{sec.masked}</span>
                    <span>rotated {sec.rotated}</span>
                  </InlineMeta>
                }
                trailing={
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {sec.agents} {sec.agents === 1 ? 'agent' : 'agents'}
                  </span>
                }
              />
            ))}
          </Panel>
        </div>

        <Panel title="Tool permissions" count="· scoped per connector">
          {POLICIES.map((p) => (
            <PolicyRow key={p.name} policy={p} />
          ))}
        </Panel>

        <div className="border-border/60 bg-muted/20 text-muted-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs">
          <MdShield className="size-4 shrink-0" />
          <span>
            SSO + 2FA enforced · secrets injected at sandbox boot, never exposed to agents · every
            tool call logged.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Page registry ─────────────────────────────────────────────────────── */

type PageIcon = LucideIcon | IconType;

const RAIL_ICON = 'size-[1.05rem] lg:size-[1.2rem]';
const TAB_ICON = 'size-4';

const PAGES: Record<
  PageId,
  { label: string; Icon: PageIcon; context: string; render: (nav: Nav) => React.ReactNode }
> = {
  home: {
    label: 'Home',
    Icon: GoHomeFill,
    context:
      'Your company\u2019s home base \u2014 start a task or pick up where your agents left off.',
    render: (nav) => <HomePage nav={nav} />,
  },
  chat: {
    label: 'Chat',
    Icon: PiChatCircleDotsFill,
    context: 'Ask in plain language and watch an agent do the real work across your tools.',
    render: () => <ChatPage />,
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
    render: () => <SkillsPage />,
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
  const page = PAGES[active];
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

  return (
    <div
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
                    {page.render(setActive)}
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
                      {page.render(setActive)}
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
