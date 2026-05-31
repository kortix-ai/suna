'use client';

import { useTranslations } from 'next-intl';

/**
 * InteractiveDemo — the homepage centerpiece.
 *
 * A high-fidelity, navigable mock of the Kortix app, rendered with the real
 * design-system atoms (Badge, EntityAvatar, UserAvatar, InlineMeta) and tokens.
 * The window shows the product as realistically as possible; the page-switching
 * controls live UNDERNEATH the screen (a pill row), not inside the UI.
 *
 * The navbar Product menu deep-links here via the URL hash (e.g. `/#agents`).
 * Purely presentational — no data, no routing.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  House,
  MessageSquare,
  Bot,
  Sparkles,
  Blocks,
  Clock,
  Radio,
  Shield,
  Plus,
  Search,
  ChevronsUpDown,
  ChevronRight,
  Check,
  FileText,
  Send,
  Paperclip,
  Mic,
  Wrench,
  Headphones,
  TrendingUp,
  Users,
  Mail,
  Globe,
  Hash,
  Key,
  Bell,
  Download,
  Settings2,
  Database,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { UserAvatar } from '@/components/ui/user-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

type PageId =
  | 'home'
  | 'chat'
  | 'agents'
  | 'skills'
  | 'integrations'
  | 'scheduling'
  | 'channels'
  | 'security';

/* ─────────────────────────── shared bits ─────────────────────────── */

function PageHead({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function FauxButton({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium',
        primary ? 'bg-foreground text-background' : 'border border-border text-foreground',
      )}
    >
      {children}
    </span>
  );
}

function Panel({ title, count, action, children, className }: { title?: string; count?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border/60 bg-card', className)}>
      {title && (
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
          <span className="text-sm font-semibold text-foreground">
            {title}
            {count && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}
          </span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Row({ leading, title, subtitle, trailing }: { leading: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0 hover:bg-muted/30">
      <span className="shrink-0">{leading}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-background">
      <Icon className="size-4 text-muted-foreground" />
    </span>
  );
}

function StatusDot({ on, label }: { on: boolean; label?: [string, string] }) {
  const [onText, offText] = label ?? ['running', 'scheduled'];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', on ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground')}>
      <span className={cn('size-1.5 rounded-full', on ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/30')} />
      {on ? onText : offText}
    </span>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-emerald-500/90' : 'justify-start bg-muted-foreground/20')}>
      <span className="size-4 rounded-full bg-white shadow" />
    </span>
  );
}

/* ─────────────────────────── pages ─────────────────────────── */

function HomePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const stats: [string, string][] = [['5', 'Active agents'], ['24', 'Sessions today'], ['12', 'Automations'], ['148', 'Tasks this week']];
  return (
    <div>
      <PageHead title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line156JsxAttrTitleGoodMorningSarah')} sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line156JsxAttrSubThursdayMay22AcmeAgi')} action={<FauxButton><Settings2 className="size-3.5" /> Customize</FauxButton>} />

      {/* composer */}
      <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="px-1 pb-2 text-sm text-muted-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line160JsxTextAskKortixToDoAnythingAcrossYourCompany')}</div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground"><Paperclip className="size-3.5" /></span>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-foreground"><Bot className="size-3.5" /> finance-agent</span>
            <span className="hidden h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground sm:inline-flex"><Sparkles className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line165JsxTextOpus47')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground"><Mic className="size-3.5" /></span>
            <span className="inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background"><Send className="size-3.5" /></span>
          </div>
        </div>
      </div>

      {/* stat tiles */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([n, l]) => (
          <div key={l} className="rounded-2xl border border-border/60 bg-card px-4 py-3">
            <div className="text-xl font-semibold tracking-tight text-foreground">{n}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{l}</div>
          </div>
        ))}
      </div>

      {/* two columns */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line186JsxAttrTitleActiveAgents')} count="· 5">
          {([
            ['finance-agent', 'Reconciled March invoices', TrendingUp, true],
            ['support-agent', 'Resolved 3 tickets in #support', Headphones, true],
            ['sdr-agent', 'Enriched 40 leads', Bot, false],
          ] as const).map(([name, last, Icon, on]) => (
            <Row key={name} leading={<EntityAvatar icon={Icon} size="sm" />} title={name} subtitle={last} trailing={<StatusDot on={on} />} />
          ))}
        </Panel>
        <Panel title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line195JsxAttrTitleRecentSessions')} count="· 3">
          {([
            ['Q3 board deck', 'finance-agent', '4m ago', 'success'],
            ['Refund policy update', 'support-agent', '1h ago', 'success'],
            ['Pipeline enrichment', 'sdr-agent', '3h ago', 'running'],
          ] as const).map(([title, agent, time, st]) => (
            <Row
              key={title}
              leading={<span className="flex size-8 items-center justify-center rounded-lg border border-border bg-muted/40"><MessageSquare className="size-3.5 text-muted-foreground" /></span>}
              title={title}
              subtitle={<InlineMeta><span>{agent}</span><span>{time}</span></InlineMeta>}
              trailing={<Badge size="sm" variant={st === 'success' ? 'success' : 'secondary'}>{st === 'success' ? 'done' : 'running'}</Badge>}
            />
          ))}
        </Panel>
      </div>
    </div>
  );
}

function ChatPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <MessageSquare className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line219JsxTextSessionsQ3BoardDeck')}</div>

      <div className="flex-1 space-y-4 overflow-hidden">
        {/* user */}
        <div className="ml-auto w-fit max-w-[82%] rounded-2xl rounded-br-sm bg-foreground px-4 py-2.5 text-sm text-background">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line225JsxTextBuildTheQ3BoardDeckFromOurLatest')}</div>

        {/* assistant */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md border border-border bg-muted/60"><Bot className="size-3.5" /></span>
            <span className="text-sm font-medium text-foreground">finance-agent</span>
            <Badge size="sm" variant="secondary">working</Badge>
            <span className="ml-auto text-xs text-muted-foreground">14:32</span>
          </div>

          {/* tool call card */}
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 text-xs">
              <Database className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-foreground">query_warehouse</span>
              <Check className="ml-auto size-3.5 text-emerald-500" />
            </div>
            <div className="space-y-1 px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
              <div><span className="text-foreground">SELECT</span>{tHardcodedUi.raw('componentsHomeInteractiveDemo.line245JsxTextRevenueBurnPipeline')}</div>
              <div><span className="text-foreground">FROM</span>{tHardcodedUi.raw('componentsHomeInteractiveDemo.line246JsxTextMetricsQ3')}<span className="text-emerald-500">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line246JsxTextText312Rows')}</span></div>
            </div>
          </div>

          {/* steps */}
          <div className="mt-3 space-y-2 pl-1">
            {['Pulled Q3 metrics from the data warehouse', 'Drafted 12 slides from your board template', 'Charted revenue, burn, and pipeline'].map((s) => (
              <div key={s} className="flex items-start gap-2.5 text-sm">
                <Check className="mt-[1px] size-3.5 shrink-0 text-emerald-500" />
                <span className="text-muted-foreground">{s}</span>
              </div>
            ))}
            <div className="flex items-start gap-2.5 text-sm">
              <span className="mt-[5px] size-1.5 shrink-0 animate-pulse rounded-full bg-foreground/40" />
              <span className="text-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line260JsxTextFormattingAmpFinalReview')}</span>
            </div>
          </div>

          {/* artifact */}
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground"><FileText className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">Q3-board-deck.pptx</div>
              <div className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line269JsxTextText12SlidesReadyIn4Min')}</div>
            </div>
            <span className="inline-flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground"><Download className="size-4" /></span>
          </div>
        </div>
      </div>

      {/* input */}
      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5 shadow-sm">
        <Paperclip className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm text-muted-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line279JsxTextReplyToFinanceAgent')}</span>
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background"><Send className="size-3.5" /></span>
      </div>
    </div>
  );
}

function AgentsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const agents: [string, string, LucideIcon, string, boolean][] = [
    ['finance-agent', 'Owns the books — reconciliation, reporting, board decks', TrendingUp, '1,204 runs', true],
    ['support-agent', 'Triages and resolves tickets across email and Slack', Headphones, '8,930 runs', true],
    ['sdr-agent', 'Enriches leads and drafts outreach from your CRM', Bot, '512 runs', true],
    ['recruiter', 'Screens candidates and schedules interviews', Users, '76 runs', true],
    ['ops-agent', 'Runs internal workflows and weekly cleanups', Wrench, '340 runs', false],
  ];
  return (
    <div>
      <PageHead title="Agents" sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line296JsxAttrSubText5Deployed4RunningNow')} action={<FauxButton primary><Plus className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line296JsxTextNewAgent')}</FauxButton>} />
      <Panel>
        {agents.map(([name, desc, Icon, runs, on]) => (
          <Row
            key={name}
            leading={<EntityAvatar icon={Icon} size="md" />}
            title={name}
            subtitle={desc}
            trailing={
              <div className="flex items-center gap-3">
                <span className="hidden text-xs text-muted-foreground sm:inline">{runs}</span>
                <StatusDot on={on} />
              </div>
            }
          />
        ))}
      </Panel>
    </div>
  );
}

function SkillsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const libs: [string, string, string[]][] = [
    ['Finance', '6 skills', ['Invoice reconciliation', 'Board reporting', 'Scenario models']],
    ['Legal', '5 skills', ['Contract review', 'Clause library', 'Cited research']],
    ['Sales', '7 skills', ['Lead enrichment', 'Deal summaries', 'Outreach drafts']],
    ['Support', '4 skills', ['Ticket triage', 'Refund policy', 'Macro replies']],
  ];
  return (
    <div>
      <PageHead title="Skills" sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line326JsxAttrSubText4LibrariesSharedAcrossEveryAgent')} action={<FauxButton primary><Plus className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line326JsxTextNewSkill')}</FauxButton>} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {libs.map(([name, count, skills]) => (
          <div key={name} className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg border border-border bg-muted/40"><Sparkles className="size-3.5 text-foreground/70" /></span>
              <span className="text-sm font-semibold text-foreground">{name}</span>
              <Badge size="sm" variant="muted" className="ml-auto">{count}</Badge>
            </div>
            <ul className="space-y-1.5">
              {skills.map((s) => (
                <li key={s} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="size-3 shrink-0" />{s}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntegrationsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tools: [string, string, boolean][] = [
    ['gmail.com', 'Gmail', true],
    ['slack.com', 'Slack', true],
    ['github.com', 'GitHub', true],
    ['stripe.com', 'Stripe', true],
    ['notion.so', 'Notion', true],
    ['hubspot.com', 'HubSpot', true],
    ['linear.app', 'Linear', false],
    ['salesforce.com', 'Salesforce', false],
    ['drive.google.com', 'Drive', true],
  ];
  return (
    <div>
      <PageHead
        title="Integrations"
        sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line365JsxAttrSubText3000Available6Connected')}
        action={<span className="hidden h-8 items-center gap-2 rounded-full border border-border bg-muted/40 px-3 text-xs text-muted-foreground sm:inline-flex"><Search className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line366JsxTextSearch')}</span>}
      />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map(([d, name, connected]) => (
          <div key={name} className="flex items-center gap-2.5 rounded-2xl border border-border/60 bg-card px-3 py-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={favicon(d)} alt={name} width={20} height={20} className="size-5 shrink-0 rounded-md" />
            <span className="truncate text-sm font-medium text-foreground">{name}</span>
            {connected ? (
              <Badge size="sm" variant="success" className="ml-auto gap-1"><span className="size-1.5 rounded-full bg-emerald-500" /> Connected</Badge>
            ) : (
              <Badge size="sm" variant="outline" className="ml-auto">Connect</Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SchedulingPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const jobs: [string, string, string, boolean][] = [
    ['Morning briefing', 'Every day · 08:00', 'in 6h', true],
    ['Weekly board report', 'Every Mon · 07:00', 'in 3d', true],
    ['Invoice reconciliation', '1st of month · 06:00', 'in 9d', true],
    ['Quarterly data cleanup', 'Every 90 days', 'paused', false],
  ];
  return (
    <div>
      <PageHead title="Scheduling" sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line395JsxAttrSubText3ActiveRunsInYourTimezone')} action={<FauxButton primary><Plus className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line395JsxTextNewSchedule')}</FauxButton>} />
      <Panel>
        {jobs.map(([name, when, next, on]) => (
          <Row
            key={name}
            leading={<IconTile icon={Clock} />}
            title={name}
            subtitle={<InlineMeta><span className="font-mono">{when}</span><span>next {next}</span></InlineMeta>}
            trailing={<Toggle on={on} />}
          />
        ))}
      </Panel>
    </div>
  );
}

function ChannelsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const channels: [string, string, string, string, LucideIcon][] = [
    ['Slack', '#support', 'support-agent', '142 today', Hash],
    ['Email', 'support@acme.ai', 'support-agent', '38 today', Mail],
    ['Web widget', 'acme.ai', 'sdr-agent', '64 today', Globe],
    ['WhatsApp', '+1 (555) 010-2048', 'concierge', '12 today', MessageSquare],
  ];
  return (
    <div>
      <PageHead title="Channels" sub={tHardcodedUi.raw('componentsHomeInteractiveDemo.line420JsxAttrSubText4ConnectedRoutingInboundToAgents')} action={<FauxButton primary><Plus className="size-3.5" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line420JsxTextAddChannel')}</FauxButton>} />
      <Panel>
        {channels.map(([name, addr, agent, vol, Icon]) => (
          <Row
            key={name}
            leading={<IconTile icon={Icon} />}
            title={<span className="flex items-center gap-2">{name}<span className="font-normal text-muted-foreground">· {addr}</span></span>}
            subtitle={<InlineMeta><span>→ {agent}</span><span>{vol}</span></InlineMeta>}
            trailing={<StatusDot on label={['live', 'paused']} />}
          />
        ))}
      </Panel>
    </div>
  );
}

function SecurityPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const members: [string, string, 'Owner' | 'Admin' | 'Member'][] = [
    ['sarah@acme.ai', 'Sarah Chen', 'Owner'],
    ['marcus@acme.ai', 'Marcus Lee', 'Admin'],
    ['priya@acme.ai', 'Priya Nair', 'Member'],
  ];
  const secrets: [string, string, string][] = [
    ['STRIPE_API_KEY', 'sk_live_••••4f2a', 'stripe.com'],
    ['OPENAI_API_KEY', 'sk-••••9c10', 'openai.com'],
    ['SLACK_BOT_TOKEN', 'xoxb-••••7d3', 'slack.com'],
  ];
  return (
    <div className="space-y-4">
      <Panel title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line449JsxAttrTitleMembersRoles')} count="· 3" action={<FauxButton><Plus className="size-3.5" /> Invite</FauxButton>}>
        {members.map(([email, name, role]) => (
          <Row
            key={email}
            leading={<UserAvatar email={email} name={name} size="sm" />}
            title={name}
            subtitle={email}
            trailing={<Badge size="sm" variant={role === 'Owner' ? 'highlight' : 'outline'}>{role}</Badge>}
          />
        ))}
      </Panel>
      <Panel title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line460JsxAttrTitleSecretsVault')} count={tHardcodedUi.raw('componentsHomeInteractiveDemo.line460JsxAttrCountEncrypted')}>
        {secrets.map(([name, masked, domain]) => (
          <Row
            key={name}
            leading={<IconTile icon={Key} />}
            title={<span className="font-mono text-xs">{name}</span>}
            subtitle={<span className="font-mono text-xs">{masked}</span>}
            trailing={
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={favicon(domain)} alt="" width={14} height={14} className="size-3.5 rounded-sm" />
                <span className="hidden sm:inline">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line471JsxTextInjectedAtRuntime')}</span>
              </span>
            }
          />
        ))}
      </Panel>
    </div>
  );
}

/* ─────────────────────────── nav config ─────────────────────────── */

const PAGES: Record<PageId, { label: string; icon: LucideIcon; context: string; render: () => React.ReactNode }> = {
  home: { label: 'Home', icon: House, context: 'Your company’s home base — start a task or pick up where your agents left off.', render: () => <HomePage /> },
  chat: { label: 'Chat', icon: MessageSquare, context: 'Ask in plain language and watch an agent do the real work across your tools.', render: () => <ChatPage /> },
  agents: { label: 'Agents', icon: Bot, context: 'A specialist for every role — finance, support, sales, ops — each its own worker.', render: () => <AgentsPage /> },
  skills: { label: 'Skills', icon: Sparkles, context: 'Package how your company does a job once — every agent can reuse it.', render: () => <SkillsPage /> },
  integrations: { label: 'Integrations', icon: Blocks, context: '3,000+ tools, connected once and shared securely across the org.', render: () => <IntegrationsPage /> },
  scheduling: { label: 'Scheduling', icon: Clock, context: 'Put work on a schedule — briefings, reports, and routines that just happen, 24/7.', render: () => <SchedulingPage /> },
  channels: { label: 'Channels', icon: Radio, context: 'Meet your team where they work — Slack, email, web, and WhatsApp route to agents.', render: () => <ChannelsPage /> },
  security: { label: 'Security', icon: Shield, context: 'Roles and scoping for people and agents, a secrets vault, and a full audit trail.', render: () => <SecurityPage /> },
};

const ORDER: PageId[] = ['home', 'chat', 'agents', 'skills', 'integrations', 'scheduling', 'channels', 'security'];

/* ─────────────────────────── shell ─────────────────────────── */

export function InteractiveDemo() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [active, setActive] = useState<PageId>('home');
  const page = PAGES[active];

  // Deep-link from the navbar Product menu via the URL hash (e.g. /#agents).
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace('#', '');
      if (h && (ORDER as string[]).includes(h)) {
        setActive(h as PageId);
        requestAnimationFrame(() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* ───────── the screen ───────── */}
      <div className="overflow-hidden rounded-[20px] border border-border bg-background shadow-2xl ring-1 ring-black/[0.02]">
        {/* app header */}
        <div className="flex h-12 items-center gap-3 border-b border-border/60 bg-muted/30 px-4">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-muted-foreground/15" />
            <span className="size-2.5 rounded-full bg-muted-foreground/15" />
            <span className="size-2.5 rounded-full bg-muted-foreground/15" />
          </div>
          <div className="ml-2 flex min-w-0 items-center gap-1.5 text-xs">
            <EntityAvatar label={tHardcodedUi.raw('componentsHomeInteractiveDemo.line528JsxAttrLabelAcmeAgi')} size="xs" />
            <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line529JsxTextAcmeAgi')}</span>
            <ChevronRight className="size-3 text-muted-foreground/40" />
            <span className="truncate text-muted-foreground">{page.label}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden h-8 w-44 items-center gap-2 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground md:flex">
              <Search className="size-3.5" /> Search
              <span className="ml-auto font-mono text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line536JsxTextK')}</span>
            </span>
            <span className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground"><Bell className="size-4" /></span>
            <UserAvatar email={tHardcodedUi.raw('componentsHomeInteractiveDemo.line539JsxAttrEmailSarahAcmeAi')} name="Sarah Chen" size="sm" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:h-[540px] lg:grid-cols-[230px_1fr]">
          {/* sidebar */}
          <aside className="hidden flex-col border-r border-border/60 bg-muted/20 p-3 lg:flex">
            <button className="mb-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]">
              <EntityAvatar label={tHardcodedUi.raw('componentsHomeInteractiveDemo.line547JsxAttrLabelAcmeAgi')} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line549JsxTextAcmeAgi')}</span>
                <span className="block truncate text-xs text-muted-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line550JsxTextEnterprise24Seats')}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            </button>

            <div className="mb-1 flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background">
              <Plus className="size-4" />{tHardcodedUi.raw('componentsHomeInteractiveDemo.line556JsxTextNewSession')}</div>
            <div className="mb-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <Search className="size-4" /> Search
              <span className="ml-auto font-mono text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line560JsxTextK')}</span>
            </div>

            <nav className="flex flex-col gap-0.5">
              {ORDER.map((id) => {
                const { label, icon: Icon } = PAGES[id];
                return (
                  <button
                    key={id}
                    onClick={() => setActive(id)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                      id === active ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto flex items-center gap-2.5 rounded-lg px-2 pb-1 pt-3">
              <UserAvatar email={tHardcodedUi.raw('componentsHomeInteractiveDemo.line583JsxAttrEmailSarahAcmeAi')} name="Sarah Chen" size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsHomeInteractiveDemo.line585JsxTextSarahChen')}</span>
                <span className="block truncate text-xs text-muted-foreground">Owner</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            </div>
          </aside>

          {/* main */}
          <div className="min-h-[460px] overflow-y-auto p-5 sm:p-6 lg:h-[540px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: 'easeInOut' }}
                className="h-full"
              >
                {page.render()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ───────── controls — underneath the screen ───────── */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
        {ORDER.map((id) => {
          const { label, icon: Icon } = PAGES[id];
          return (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors',
                id === active
                  ? 'bg-foreground text-background'
                  : 'border border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* context caption */}
      <AnimatePresence mode="wait">
        <motion.p
          key={active}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          className="mx-auto mt-5 max-w-xl text-center text-sm leading-relaxed text-muted-foreground"
        >
          {page.context}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
