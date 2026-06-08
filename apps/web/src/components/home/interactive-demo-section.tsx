'use client';

import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Warp } from '@paper-design/shaders-react';
import {
  Bell,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileText,
  Globe,
  Hash,
  Headphones,
  Key,
  Mail,
  MessageSquare,
  Paperclip,
  Plus,
  Radio,
  Search,
  TrendingUp,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { FaCircle } from 'react-icons/fa';
import { GoHomeFill } from 'react-icons/go';
import { HiMiniSparkles } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { PiChatCircleDotsFill, PiCheckCircleFill, PiClockCountdownFill } from 'react-icons/pi';
import { RiMessage2Fill, RiMicAiFill, RiRobot3Fill, RiSettings3Fill } from 'react-icons/ri';
import { Button } from '../ui/marketing/button';

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
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
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
}: {
  leading: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="border-border hover:bg-muted/30 flex items-center gap-3 border-b px-4 py-3 last:border-0">
      <span className="shrink-0">{leading}</span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="text-muted-foreground truncate text-xs">{subtitle}</div>}
      </div>
      {trailing && (
        <Badge size="sm" variant="transparent">
          {trailing}
        </Badge>
      )}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="border-border bg-background flex size-8 items-center justify-center rounded-lg border">
      <Icon className="text-muted-foreground size-4" />
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

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'flex h-5 w-9 items-center rounded-full p-0.5 transition-colors',
        on ? 'justify-end bg-emerald-500/90' : 'bg-muted-foreground/20 justify-start',
      )}
    >
      <span className="size-4 rounded-full bg-white shadow" />
    </span>
  );
}

function HomePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const stats: [string, string][] = [
    ['5', 'Active agents'],
    ['24', 'Sessions today'],
    ['12', 'Automations'],
    ['148', 'Tasks this week'],
  ];
  return (
    <div>
      <PageHead
        title={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line156JsxAttrTitleGoodMorningSarah',
        )}
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line156JsxAttrSubThursdayMay22AcmeAgi',
        )}
        action={
          <Button variant="default" size="sm">
            <RiSettings3Fill className="size-3.5" /> Customize
          </Button>
        }
      />

      <div className="border-border bg-card rounded-md border p-3">
        <div className="text-muted-foreground px-1 pb-2 text-sm">
          {tHardcodedUi.raw(
            'componentsHomeInteractiveDemo.line160JsxTextAskKortixToDoAnythingAcrossYourCompany',
          )}
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground inline-flex size-7 items-center justify-center rounded-sm">
              <Paperclip className="size-3.5" />
            </span>
            <span className="text-foreground inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs">
              <RiRobot3Fill className="size-3.5" /> finance-agent
            </span>
            <span className="text-muted-foreground hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-xs sm:inline-flex">
              <Icon.Claude className="size-3.5" />
              {tHardcodedUi.raw('componentsHomeInteractiveDemo.line165JsxTextOpus47')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground inline-flex size-7 items-center justify-center">
              <RiMicAiFill className="size-3.5" />
            </span>
            <span className="bg-foreground text-background inline-flex size-6 items-center justify-center rounded-sm">
              <svg
                className="size-3.5"
                width="24"
                height="24"
                fill="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([n, l]) => (
          <div key={l} className="border-border bg-card rounded-sm border px-4 py-3">
            <div className="text-foreground text-xl font-semibold tracking-tight">{n}</div>
            <div className="text-muted-foreground mt-0.5 text-xs">{l}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line186JsxAttrTitleActiveAgents')}
          count="· 5"
        >
          {(
            [
              ['finance-agent', 'Reconciled March invoices', TrendingUp, true],
              ['support-agent', 'Resolved 3 tickets in #support', Headphones, true],
              ['sdr-agent', 'Enriched 40 leads', Bot, false],
            ] as const
          ).map(([name, last, Icon, on]) => (
            <Row
              key={name}
              leading={<EntityAvatar icon={Icon} size="md" />}
              title={name}
              subtitle={last}
              trailing={<StatusDot on={on} />}
            />
          ))}
        </Panel>
        <Panel
          title={tHardcodedUi.raw(
            'componentsHomeInteractiveDemo.line195JsxAttrTitleRecentSessions',
          )}
          count="· 3"
        >
          {(
            [
              ['Q3 board deck', 'finance-agent', '4m ago', 'success'],
              ['Refund policy update', 'support-agent', '1h ago', 'success'],
              ['Pipeline enrichment', 'sdr-agent', '3h ago', 'running'],
            ] as const
          ).map(([title, agent, time, st]) => (
            <Row
              key={title}
              leading={
                <span className="border-border bg-muted/40 flex size-8 items-center justify-center rounded-md border">
                  <RiMessage2Fill className="text-muted-foreground size-3.5" />
                </span>
              }
              title={title}
              subtitle={
                <InlineMeta>
                  <span>{agent}</span>
                  <span>{time}</span>
                </InlineMeta>
              }
              trailing={
                <Badge size="sm" variant={st === 'success' ? 'badgeSuccess' : 'secondary'}>
                  {st === 'success' ? 'done' : 'running'}
                </Badge>
              }
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
      <div className="text-muted-foreground mb-4 flex items-center gap-2 font-mono text-xs">
        <MessageSquare className="size-3.5" />
        {tHardcodedUi.raw('componentsHomeInteractiveDemo.line219JsxTextSessionsQ3BoardDeck')}
      </div>

      <div className="flex-1 space-y-4 overflow-hidden">
        <div className="bg-foreground text-background ml-auto w-fit max-w-[82%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
          {tHardcodedUi.raw(
            'componentsHomeInteractiveDemo.line225JsxTextBuildTheQ3BoardDeckFromOurLatest',
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-foreground flex items-center gap-2 text-sm font-medium">
              <RiRobot3Fill className="size-3.5" />
              finance-agent
            </span>
            <Badge size="sm" variant="secondary">
              working
            </Badge>
            <span className="text-muted-foreground ml-auto text-xs">14:32</span>
          </div>

          <div className="border-border/60 bg-card overflow-hidden rounded-md border">
            <div className="border-border/60 bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs">
              <Database className="text-muted-foreground size-3.5" />
              <span className="text-foreground font-medium">query_warehouse</span>
              <Check className="ml-auto size-3.5 text-emerald-500" />
            </div>
            <div className="text-muted-foreground space-y-1 px-3 py-2.5 font-mono text-xs leading-relaxed">
              <div>
                <span className="text-foreground">SELECT</span>
                {tHardcodedUi.raw(
                  'componentsHomeInteractiveDemo.line245JsxTextRevenueBurnPipeline',
                )}
              </div>
              <div>
                <span className="text-foreground">FROM</span>
                {tHardcodedUi.raw('componentsHomeInteractiveDemo.line246JsxTextMetricsQ3')}
                <span className="text-emerald-500">
                  {tHardcodedUi.raw('componentsHomeInteractiveDemo.line246JsxTextText312Rows')}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-2 pl-1">
            {[
              'Pulled Q3 metrics from the data warehouse',
              'Drafted 12 slides from your board template',
              'Charted revenue, burn, and pipeline',
            ].map((s) => (
              <div key={s} className="flex items-center gap-2 text-sm">
                <PiCheckCircleFill className="text-kortix-green size-3.5 shrink-0" />
                <span className="text-muted-foreground">{s}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 text-sm">
              <FaCircle className="text-muted-foreground size-3 shrink-0" />
              <span className="text-foreground">
                {tHardcodedUi.raw(
                  'componentsHomeInteractiveDemo.line260JsxTextFormattingAmpFinalReview',
                )}
              </span>
            </div>
          </div>

          <div className="border-border/60 bg-card mt-3 flex items-center gap-3 rounded-md border p-3">
            <span className="bg-foreground/[0.06] text-foreground flex size-9 items-center justify-center rounded-lg">
              <FileText className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-foreground text-sm font-medium">Q3-board-deck.pptx</div>
              <div className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsHomeInteractiveDemo.line269JsxTextText12SlidesReadyIn4Min',
                )}
              </div>
            </div>
            <span className="text-background/90 bg-primary/90 inline-flex size-8 items-center justify-center rounded-md border">
              <Download className="size-4" />
            </span>
          </div>
        </div>
      </div>

      <div className="border-border bg-card mt-4 flex items-center gap-2 rounded-md border p-2.5">
        <Paperclip className="text-muted-foreground size-4" />
        <span className="text-muted-foreground flex-1 text-sm">
          {tHardcodedUi.raw('componentsHomeInteractiveDemo.line279JsxTextReplyToFinanceAgent')}
        </span>
        <span className="text-background bg-primary/90 inline-flex size-7 items-center justify-center rounded-md">
          <svg
            className="size-3.5"
            width="24"
            height="24"
            fill="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
          </svg>
        </span>
      </div>
    </div>
  );
}

function AgentsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const agents: [string, string, LucideIcon, string, boolean][] = [
    [
      'finance-agent',
      'Owns the books — reconciliation, reporting, board decks',
      TrendingUp,
      '1,204 runs',
      true,
    ],
    [
      'support-agent',
      'Triages and resolves tickets across email and Slack',
      Headphones,
      '8,930 runs',
      true,
    ],
    ['sdr-agent', 'Enriches leads and drafts outreach from your CRM', Bot, '512 runs', true],
    ['recruiter', 'Screens candidates and schedules interviews', Users, '76 runs', true],
    ['ops-agent', 'Runs internal workflows and weekly cleanups', Wrench, '340 runs', false],
  ];
  return (
    <div>
      <PageHead
        title="Agents"
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line296JsxAttrSubText5Deployed4RunningNow',
        )}
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" />
            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line296JsxTextNewAgent')}
          </Button>
        }
      />
      <Panel>
        {agents.map(([name, desc, Icon, runs, on]) => (
          <Row
            key={name}
            leading={<EntityAvatar icon={Icon} size="md" />}
            title={name}
            subtitle={desc}
            trailing={
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground hidden text-xs sm:inline">{runs}</span>
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
      <PageHead
        title="Skills"
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line326JsxAttrSubText4LibrariesSharedAcrossEveryAgent',
        )}
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" />
            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line326JsxTextNewSkill')}
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {libs.map(([name, count, skills]) => (
          <div key={name} className="border-border/60 bg-card rounded-md border p-3">
            <div className="mb-3 flex items-center gap-2">
              <span className="border-border bg-muted/40 flex size-7 items-center justify-center rounded-md border">
                <HiMiniSparkles className="text-foreground/70 size-3.5" />
              </span>
              <span className="text-foreground text-sm font-semibold">{name}</span>
              <Badge size="sm" variant="muted" className="ml-auto">
                {count}
              </Badge>
            </div>
            <ul className="space-y-1.5">
              {skills.map((s) => (
                <li key={s} className="text-muted-foreground flex items-center gap-2 text-sm">
                  <FileText className="size-3 shrink-0" />
                  {s}
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
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line365JsxAttrSubText3000Available6Connected',
        )}
        action={
          <span className="border-border bg-muted/40 text-muted-foreground hidden h-8 items-center gap-2 rounded-full border px-3 text-xs sm:inline-flex">
            <Search className="size-3.5" />
            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line366JsxTextSearch')}
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map(([d, name, connected]) => (
          <div
            key={name}
            className="border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5"
          >
            <img
              src={favicon(d)}
              alt={name}
              width={20}
              height={20}
              className="size-5 shrink-0 rounded-md"
            />
            <span className="text-foreground truncate text-sm font-medium">{name}</span>
            {connected ? (
              <Badge size="sm" variant="success" className="ml-auto gap-1">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Connected
              </Badge>
            ) : (
              <Badge size="sm" variant="outline" className="ml-auto">
                Connect
              </Badge>
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
      <PageHead
        title="Scheduling"
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line395JsxAttrSubText3ActiveRunsInYourTimezone',
        )}
        action={
          <Button size="sm">
            <Plus className="size-3.5" />
            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line395JsxTextNewSchedule')}
          </Button>
        }
      />
      <Panel>
        {jobs.map(([name, when, next, on]) => (
          <Row
            key={name}
            leading={<IconTile icon={Clock} />}
            title={name}
            subtitle={
              <InlineMeta>
                <span className="font-mono">{when}</span>
                <span>next {next}</span>
              </InlineMeta>
            }
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
      <PageHead
        title="Channels"
        sub={tHardcodedUi.raw(
          'componentsHomeInteractiveDemo.line420JsxAttrSubText4ConnectedRoutingInboundToAgents',
        )}
        action={
          <Button size="sm">
            <Plus className="size-3.5" />
            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line420JsxTextAddChannel')}
          </Button>
        }
      />
      <Panel>
        {channels.map(([name, addr, agent, vol, Icon]) => (
          <Row
            key={name}
            leading={<IconTile icon={Icon} />}
            title={
              <span className="flex items-center gap-2">
                {name}
                <span className="text-muted-foreground font-normal">· {addr}</span>
              </span>
            }
            subtitle={
              <InlineMeta>
                <span>→ {agent}</span>
                <span>{vol}</span>
              </InlineMeta>
            }
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
      <Panel
        title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line449JsxAttrTitleMembersRoles')}
        count="· 3"
        action={
          <Button variant="outline" size="sm">
            <Plus className="size-3.5" /> Invite
          </Button>
        }
      >
        {members.map(([email, name, role]) => (
          <Row
            key={email}
            leading={<UserAvatar email={email} name={name} size="sm" />}
            title={name}
            subtitle={email}
            trailing={
              <Badge size="sm" variant={role === 'Owner' ? 'highlight' : 'outline'}>
                {role}
              </Badge>
            }
          />
        ))}
      </Panel>
      <Panel
        title={tHardcodedUi.raw('componentsHomeInteractiveDemo.line460JsxAttrTitleSecretsVault')}
        count={tHardcodedUi.raw('componentsHomeInteractiveDemo.line460JsxAttrCountEncrypted')}
      >
        {secrets.map(([name, masked, domain]) => (
          <Row
            key={name}
            leading={<IconTile icon={Key} />}
            title={<span className="font-mono text-xs">{name}</span>}
            subtitle={<span className="font-mono text-xs">{masked}</span>}
            trailing={
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <img
                  src={favicon(domain)}
                  alt=""
                  width={14}
                  height={14}
                  className="size-3.5 rounded-sm"
                />
                <span className="hidden sm:inline">
                  {tHardcodedUi.raw(
                    'componentsHomeInteractiveDemo.line471JsxTextInjectedAtRuntime',
                  )}
                </span>
              </span>
            }
          />
        ))}
      </Panel>
    </div>
  );
}

const PAGES: Record<
  PageId,
  { label: string; icon: React.ReactNode; context: string; render: () => React.ReactNode }
> = {
  home: {
    label: 'Home',
    icon: <GoHomeFill className="size-4" />,
    context: 'Your company’s home base — start a task or pick up where your agents left off.',
    render: () => <HomePage />,
  },
  chat: {
    label: 'Chat',
    icon: <PiChatCircleDotsFill className="size-4" />,
    context: 'Ask in plain language and watch an agent do the real work across your tools.',
    render: () => <ChatPage />,
  },
  agents: {
    label: 'Agents',
    icon: <RiRobot3Fill className="size-4" />,
    context: 'A specialist for every role — finance, support, sales, ops — each its own worker.',
    render: () => <AgentsPage />,
  },
  skills: {
    label: 'Skills',
    icon: <HiMiniSparkles className="size-4" />,
    context: 'Package how your company does a job once — every agent can reuse it.',
    render: () => <SkillsPage />,
  },
  integrations: {
    label: 'Integrations',
    icon: <Blocks className="size-4" />,
    context: '3,000+ tools, connected once and shared securely across the org.',
    render: () => <IntegrationsPage />,
  },
  scheduling: {
    label: 'Scheduling',
    icon: <PiClockCountdownFill className="size-4" />,
    context: 'Put work on a schedule — briefings, reports, and routines that just happen, 24/7.',
    render: () => <SchedulingPage />,
  },
  channels: {
    label: 'Channels',
    icon: <Radio className="size-4" />,
    context: 'Meet your team where they work — Slack, email, web, and WhatsApp route to agents.',
    render: () => <ChannelsPage />,
  },
  security: {
    label: 'Security',
    icon: <MdShield className="size-4" />,
    context: 'Roles and scoping for people and agents, a secrets vault, and a full audit trail.',
    render: () => <SecurityPage />,
  },
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

const ORDER: PageId[] = [
  'home',
  'chat',
  'agents',
  'skills',
  'integrations',
  'scheduling',
  'channels',
  'security',
];

export function InteractiveDemoSection({
  gradientbg = true,
  tab = true,
  embedded = false,
  className,
  contentClassName,
  innerClassName,
  aside = true,
  parentClassName,
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
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [active, setActive] = useState<PageId>('home');
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
              'border-border bg-background overflow-hidden lg:border-none lg:bg-transparent',
              embedded && 'flex h-full flex-col',
              innerClassName,
              aside && 'rounded sm:rounded-sm',
            )}
          >
            {tab && (
              <>
                <div className="hidden w-full lg:block">
                  <div className="mx-auto w-full max-w-full [scrollbar-width:none] overflow-x-auto scroll-smooth [-ms-overflow-style:none] lg:w-auto lg:overflow-visible [&::-webkit-scrollbar]:hidden">
                    <div className="bg-border dark:bg-background mx-auto w-full rounded-xl p-1">
                      <div className="shadow-custom flex w-full items-center gap-0.5 rounded-full">
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
                                index !== 0 && 'rounded-tl-none',
                                index !== ORDER.length && 'rounded-tr-none',
                              )}
                              type="button"
                              onClick={() => setActive(id)}
                            >
                              {isActive ? (
                                <span className="relative flex items-stretch">
                                  {index !== 0 && <TabScallopEdge side="left" />}
                                  <span className="bg-background dark:bg-primary/7 relative z-10 flex items-center gap-2 rounded-t-xl px-3.5 py-1 [&>svg]:size-4">
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

                      <div
                        className={cn(
                          'bg-background h-full w-full overflow-hidden rounded-b-[calc(var(--radius-xl)-4px)]',
                        )}
                      >
                        <div
                          className={cn(
                            'border-border/60 bg-background dark:bg-primary/7 flex shrink-0 items-center gap-3 px-4',
                            embedded ? 'h-9 px-3' : 'h-12',
                            !aside ? 'bg-card' : 'border-b',
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
                              {tHardcodedUi.raw(
                                'componentsHomeInteractiveDemo.line539JsxTextSarahAcmeAi',
                              )}
                            </span>
                          </div>
                        </div>

                        <div
                          className={cn(
                            'grid min-h-0 w-full grid-cols-1',
                            aside
                              ? 'lg:h-[540px] lg:grid-cols-[230px_1fr]'
                              : 'bg-background h-full rounded-t-md lg:h-full lg:grid-cols-1',
                            embedded && 'h-full flex-1 rounded-t-md',
                            parentClassName,
                          )}
                        >
                          {aside && (
                            <aside className="border-border/60 bg-muted/20 hidden flex-col border-r p-3 lg:flex">
                              <div className="bg-foreground text-background border-border mb-1 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium">
                                <Plus className="size-4" />
                                {tHardcodedUi.raw(
                                  'componentsHomeInteractiveDemo.line556JsxTextNewSession',
                                )}
                              </div>
                              <div className="text-muted-foreground mb-3 flex items-center gap-2.5 rounded-md p-1.5 px-2.5 text-sm">
                                <Search className="size-4" /> Search
                                <span className="text-muted-foreground/50 ml-auto font-mono text-xs">
                                  {tHardcodedUi.raw(
                                    'componentsHomeInteractiveDemo.line560JsxTextK',
                                  )}
                                </span>
                              </div>

                              <nav className="flex flex-col gap-0.5">
                                {ORDER.map((id) => {
                                  const { label, icon: Icon } = PAGES[id];
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
                                      {Icon}
                                      {label}
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
                                    {tHardcodedUi.raw(
                                      'componentsHomeInteractiveDemo.line585JsxTextSarahChen',
                                    )}
                                  </span>
                                  <span className="text-muted-foreground block truncate text-xs">
                                    Owner
                                  </span>
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
                                {page.render()}
                              </motion.div>
                            </AnimatePresence>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:hidden">
                  <div className="mx-auto w-full max-w-full [scrollbar-width:none] overflow-x-auto scroll-smooth [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    <div className="bg-border dark:bg-background w-max min-w-full  pt-1">
                      <div className="shadow-custom flex w-max items-center gap-0.5 overflow-hidden ">
                        {ORDER.map((id, index) => {
                          const { label, icon: Icon } = PAGES[id];
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
                              className={cn(
                                'text-foreground hit-area-3 flex shrink-0 cursor-pointer items-center justify-center transition-colors duration-150 ease-out',
                                !isActive ? 'gap-2 rounded-full px-3.5 py-0 [&>svg]:size-4' : '',
                                index !== 0 && 'rounded-tl-none',
                                index !== ORDER.length && 'rounded-tr-none',
                              )}
                              type="button"
                              onClick={() => setActive(id)}
                            >
                              {isActive ? (
                                <span className="relative flex items-stretch">
                                  {index !== 0 && <TabScallopEdge side="left" />}
                                  <span className="bg-background dark:bg-primary/7 relative z-10 flex items-center gap-2 rounded-t-xl px-3.5 py-1 [&>svg]:size-4">
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
                    </div>
                  </div>

                  <div
                    className={cn(
                      'border-border/60 bg-background dark:bg-primary/7 flex shrink-0 items-center gap-3 px-4',
                      embedded ? 'h-9 px-3' : 'h-12',
                      !aside ? 'bg-card' : 'border-b',
                    )}
                  >
                    <div className="flex gap-1.5">
                      <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
                      <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
                      <span className="bg-muted-foreground/15 size-2.5 rounded-full" />
                    </div>

                    {aside && (
                      <div className="ml-2 flex min-w-0 items-center gap-1.5 text-xs">
                        <EntityAvatar
                          label={tHardcodedUi.raw(
                            'componentsHomeInteractiveDemo.line528JsxAttrLabelAcmeAgi',
                          )}
                          size="xs"
                        />
                        <span className="text-foreground font-medium">
                          {tHardcodedUi.raw('componentsHomeInteractiveDemo.line529JsxTextAcmeAgi')}
                        </span>
                        <ChevronRight className="text-muted-foreground/40 size-3" />
                        <span className="text-muted-foreground truncate">{page.label}</span>
                      </div>
                    )}

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
                        {tHardcodedUi.raw(
                          'componentsHomeInteractiveDemo.line539JsxTextSarahAcmeAi',
                        )}
                      </span>
                    </div>
                  </div>

                  <div
                    className={cn(
                      'grid min-h-0 w-full grid-cols-1',
                      aside
                        ? 'lg:h-[540px] lg:grid-cols-[230px_1fr]'
                        : 'bg-background h-full rounded-t-md lg:h-full lg:grid-cols-1',
                      embedded && 'h-full flex-1 rounded-t-md',
                      parentClassName,
                    )}
                  >
                    {aside && (
                      <aside className="border-border/60 bg-muted/20 hidden flex-col border-r p-3 lg:flex">
                        <button className="hover:bg-foreground/[0.04] mb-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors">
                          <EntityAvatar
                            label={tHardcodedUi.raw(
                              'componentsHomeInteractiveDemo.line547JsxAttrLabelAcmeAgi',
                            )}
                            size="md"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="text-foreground block truncate text-xs font-semibold">
                              {tHardcodedUi.raw(
                                'componentsHomeInteractiveDemo.line549JsxTextAcmeAgi',
                              )}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {tHardcodedUi.raw(
                                'componentsHomeInteractiveDemo.line550JsxTextEnterprise24Seats',
                              )}
                            </span>
                          </span>
                        </button>

                        <div className="bg-foreground text-background border-border mb-1 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium">
                          <Plus className="size-4" />
                          {tHardcodedUi.raw(
                            'componentsHomeInteractiveDemo.line556JsxTextNewSession',
                          )}
                        </div>
                        <div className="text-muted-foreground mb-3 flex items-center gap-2.5 rounded-md p-1.5 px-2.5 text-sm">
                          <Search className="size-4" /> Search
                          <span className="text-muted-foreground/50 ml-auto font-mono text-xs">
                            {tHardcodedUi.raw('componentsHomeInteractiveDemo.line560JsxTextK')}
                          </span>
                        </div>

                        <nav className="flex flex-col gap-0.5">
                          {ORDER.map((id) => {
                            const { label, icon: Icon } = PAGES[id];
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
                                {Icon}
                                {label}
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
                              {tHardcodedUi.raw(
                                'componentsHomeInteractiveDemo.line585JsxTextSarahChen',
                              )}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              Owner
                            </span>
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
                          {page.render()}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
