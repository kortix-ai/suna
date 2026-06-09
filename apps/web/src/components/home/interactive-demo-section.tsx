'use client';

import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
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
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileText,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { GoHomeFill } from 'react-icons/go';
import { HiMiniSparkles } from 'react-icons/hi2';
import { IconType } from 'react-icons/lib';
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
import { ChatPage } from './interactive-demo/pages/chat-page';
import { SkillsPage } from './interactive-demo/pages/skills-page';

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
        <div className="mt-2 flex w-full shrink-0 flex-col items-start justify-start space-y-4 sm:mt-4 sm:space-y-6">
          <span className="hidden md:block">
            <KortixLogo size={24} variant="logomark" />
          </span>
          <span className="block md:hidden">
            <KortixLogo size={18} variant="logomark" />
          </span>

          <div className="w-full min-w-0">
            <div className="text-muted-foreground/70 mb-2 px-0.5 text-xs font-medium tracking-wider uppercase">
              Build out your project
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-2.5 lg:grid-cols-3">
              {cards.map(([title, sub, Icon, count, target]) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => nav(target)}
                  className="border-border/70 bg-card hover:border-border hover:bg-muted/30 group flex items-center gap-2.5 rounded-md border p-2.5 text-left transition-colors sm:gap-3 sm:p-3"
                >
                  <span className="border-border bg-background flex size-8 shrink-0 items-center justify-center rounded-lg border sm:size-9">
                    <Icon className="text-foreground/70 size-3.5 sm:size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground flex items-center gap-1.5 text-xs font-medium sm:text-sm">
                      {title}
                      {count && (
                        <Badge size="sm" variant="muted">
                          {count}
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-[11px] sm:text-xs">
                      {sub}
                    </span>
                  </span>
                  <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-3.5 shrink-0 transition-colors sm:size-4" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-auto w-full shrink-0 pt-3 sm:pt-4">
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

type DemoExtras = {
  focusedSkill: string | null;
  onSkillClick: (name: string) => void;
};

const PAGES: Record<
  PageId,
  {
    label: string;
    icon: React.ReactNode;
    render: (nav: Nav, convo: DemoConversation, extras: DemoExtras) => React.ReactNode;
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
    render: (_nav, convo, extras) => <ChatPage convo={convo} onSkillClick={extras.onSkillClick} />,
  },
  agents: {
    label: 'Agents',
    icon: <RiRobot3Fill className="size-4" />,
    render: () => <AgentsPage />,
  },
  skills: {
    label: 'Skills',
    icon: <HiMiniSparkles className="size-4" />,
    render: (_nav, _convo, extras) => <SkillsPage focusedSkill={extras.focusedSkill} />,
  },
  integrations: {
    label: 'Integrations',
    icon: <Blocks className="size-4" />,
    render: () => <IntegrationsPage />,
  },
  models: {
    label: 'Models',
    icon: <RiCpuLine className="size-4" />,
    render: () => <ModelsPage />,
  },
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
  const [focusedSkill, setFocusedSkill] = useState<string | null>(null);
  const convo = useDemoConversation({ onEnterChat: () => setActive('chat') });
  const page = PAGES[active];
  const rootRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  const tabRefs = useRef<Partial<Record<PageId, HTMLButtonElement>>>({});

  const handleSkillClick = useCallback((name: string) => {
    setFocusedSkill(name);
    setActive('skills');
  }, []);

  useEffect(() => {
    if (active !== 'skills') setFocusedSkill(null);
  }, [active]);

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

  // Auto-play once when the demo scrolls into view — type on Home, then submit.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const hash = window.location.hash.replace('#', '');
    if (hash && hash !== 'demo' && hash !== 'home' && (ORDER as string[]).includes(hash)) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !autoStarted.current) {
          autoStarted.current = true;
          io.disconnect();
          convo.startAutoDemo(AUTO_DEMO_PROMPT);
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
                        {index !== ORDER.length && <TabScallopEdge side="right" />}
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
              {/* <TopBar label={page.label} embedded={embedded} /> */}

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
                    {page.render(setActive, convo, {
                      focusedSkill,
                      onSkillClick: handleSkillClick,
                    })}
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
