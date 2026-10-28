'use client';

import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Switch } from '@kortix/ui/switch';
import {
  ArrowUpRightIcon,
  ClockIcon,
  EnvelopeSimpleIcon,
  GitPullRequestIcon,
  PlusIcon,
  ShieldCheckIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { SessionStatusMark } from './session-status-mark';
import { AppBoard } from './session-window';

/**
 * The Customize page of the Northwind project, drawn like the app's
 * (capability-tabs.tsx + capability-page-shell.tsx) inside the session
 * window's chrome. The hero's Workspace steps 2 to 4 show its Connectors,
 * Triggers and Review tabs. Every name is a synthetic Northwind fixture.
 */

export type CustomizeTab = 'Connectors' | 'Triggers' | 'Review';

/** CAPABILITY_TABS in packages/ui/src/internal/lib/capability-tab-routes.ts; Members is a link. */
const TABS = ['Agents', 'Skills', 'Connectors', 'Triggers', 'Reminders', 'Models', 'Secrets', 'Repo', 'Review'];

function TabBar({ tab }: { tab: CustomizeTab }) {
  const item = (label: string) => (
    <span
      key={label}
      aria-current={label === tab ? 'page' : undefined}
      className="text-muted-foreground aria-[current=page]:text-foreground relative py-3.5 text-sm font-medium whitespace-nowrap"
    >
      {label}
      {label === tab ? <span className="bg-foreground absolute inset-x-0 bottom-0 h-0.5" /> : null}
    </span>
  );
  return (
    <div className="flex h-13 shrink-0 items-center gap-5 border-b px-6">
      {item(TABS[0])}
      <span aria-hidden className="bg-border h-4 w-px" />
      {TABS.slice(1).map(item)}
      <span className="text-muted-foreground ml-auto flex items-center gap-1 text-sm font-medium">
        Members
        <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
      </span>
      {item('Settings')}
    </div>
  );
}

/** The page header of CapabilityPageShell: title and description left, action right. */
function Shell({
  title,
  description,
  action,
  filters,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="animate-in fade-in duration-slower mx-auto flex w-full max-w-5xl flex-col gap-5 px-10 py-12 ease-out">
      <header className="flex items-start justify-between gap-3">
        <div className="flex max-w-md flex-col gap-1">
          <h3 className="text-xl font-medium">{title}</h3>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {action}
      </header>
      {filters}
      {children}
    </div>
  );
}

/** A quiet segmented filter row, the first item selected. */
function Filters({ items }: { items: string[] }) {
  return (
    <div className="bg-muted flex w-fit items-center rounded-md p-0.5">
      {items.map((label, i) => (
        <span
          key={label}
          className={cn(
            'flex h-7 items-center rounded-sm px-2.5 text-xs font-medium',
            i === 0 ? 'bg-background text-foreground' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

const COLOR = '/media/landing/logos/color';

const CONNECTORS: { name: string; mark: ReactNode; detail: string }[] = [
  { name: 'GitHub', mark: <BrandGlyph slug="github" />, detail: 'eng-triage' },
  { name: 'LinkedIn', mark: <BrandGlyph slug="linkedin" />, detail: 'marketing, sales-inbound' },
  { name: 'HubSpot', mark: <BrandGlyph slug="hubspot" />, detail: 'sales-inbound' },
  {
    name: 'Slack',
    mark: <Image src={`${COLOR}/slack.svg`} alt="" width={20} height={20} unoptimized className="size-5" />,
    detail: 'Built in',
  },
  { name: 'Email', mark: <EnvelopeSimpleIcon className="size-5" aria-hidden />, detail: 'Built in' },
  { name: 'Notion', mark: <BrandGlyph slug="notion" />, detail: 'kortix' },
];

const POLICY = ['Allow', 'Ask', 'Block'] as const;

/** LinkedIn's rules, as kortix.yaml sets them: `linkedin.create_*` asks first. */
const RULES: { tool: string; does: string; policy: (typeof POLICY)[number] }[] = [
  { tool: 'linkedin.get_profile', does: 'Reads a profile', policy: 'Allow' },
  { tool: 'linkedin.create_post', does: 'Publishes a post', policy: 'Ask' },
  { tool: 'linkedin.create_comment', does: 'Comments on a post', policy: 'Ask' },
  { tool: 'linkedin.delete_post', does: 'Deletes a post', policy: 'Block' },
];

function ConnectorsPage() {
  return (
    <Shell
      title="Connectors"
      description="The apps your agents work in. Connector keys stay on the server."
      action={
        <Button size="sm" variant="outline">
          <ShieldCheckIcon />
          Global rules
        </Button>
      }
      filters={<Filters items={['Connected', 'All', 'Discovery']} />}
    >
      <ul className="grid grid-cols-3 gap-3">
        {CONNECTORS.map((c) => (
          <li key={c.name} className="bg-card flex items-center gap-3 rounded-lg border px-4 py-3.5">
            <span className="bg-background flex size-9 items-center justify-center rounded-md border">{c.mark}</span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-muted-foreground truncate text-xs">{c.detail}</span>
            </span>
            <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
              <span className="bg-kortix-green size-1.5 rounded-full" aria-hidden />
              Connected
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 pt-3">
        <p className="text-sm font-medium">LinkedIn rules</p>
        <ul className="divide-y rounded-lg border">
          {RULES.map((rule) => (
            <li key={rule.tool} className="flex items-center gap-4 px-4 py-2.5">
              <span className="w-60 font-mono text-xs">{rule.tool}</span>
              <span className="text-muted-foreground text-sm">{rule.does}</span>
              <span className="bg-muted ml-auto flex items-center rounded-md p-0.5">
                {POLICY.map((p) => (
                  <span
                    key={p}
                    className={cn(
                      'flex h-6 items-center rounded-sm px-2.5 text-xs font-medium',
                      p === rule.policy ? 'bg-background text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {p}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}

/** The three triggers in kortix.yaml, then two schedules set in the app. */
const TRIGGERS: { name: string; on: string; webhook?: boolean; agent: string; last: string; running?: boolean }[] = [
  { name: 'New GitHub issue', on: 'Webhook', webhook: true, agent: 'eng-triage', last: 'Running now', running: true },
  { name: 'Inbound lead', on: 'Webhook', webhook: true, agent: 'sales-inbound', last: '22m ago' },
  { name: 'Weekly LinkedIn post', on: 'Tuesdays at 10:00', agent: 'marketing', last: 'Tue 10:00' },
  { name: 'Monday revenue report', on: 'Mondays at 08:00', agent: 'kortix', last: 'Mon 08:00' },
  { name: 'Month-end close', on: '1st of the month at 08:00', agent: 'kortix', last: 'Oct 1, 08:00' },
];

function TriggersPage() {
  return (
    <Shell
      title="Triggers"
      description="Run agents on a schedule, an app event, or a webhook."
      action={
        <Button size="sm">
          <PlusIcon />
          New trigger
        </Button>
      }
      filters={<Filters items={['All', 'Schedules', 'Connector events', 'App events', 'Webhooks']} />}
    >
      <ul className="divide-y rounded-lg border">
        {TRIGGERS.map((t) => (
          <li key={t.name} className="flex items-center gap-4 px-4 py-3.5">
            <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
              {t.webhook ? <WebhooksLogoIcon className="size-4" /> : <ClockIcon className="size-4" />}
            </span>
            <span className="flex w-64 flex-col">
              <span className="text-sm font-medium">{t.name}</span>
              <span className="text-muted-foreground text-xs">{t.on}</span>
            </span>
            <span className="text-muted-foreground font-mono text-xs">→ {t.agent}</span>
            <span className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
              {t.running ? <SessionStatusMark status="running" /> : null}
              {t.last}
            </span>
            <Switch checked aria-label={`${t.name} is on`} tabIndex={-1} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

const QUEUE: { icon: ReactNode; title: string; meta: string; actions: [string, string] }[] = [
  {
    icon: <GitPullRequestIcon className="size-4" />,
    title: 'Add the weekly LinkedIn post',
    meta: '#12 · marketing · weekly-post → main',
    actions: ['Request changes', 'Merge'],
  },
  {
    icon: <ShieldCheckIcon className="size-4" />,
    title: 'linkedin.create_post: "CSV export streams large files"',
    meta: 'marketing · asks first',
    actions: ['Deny', 'Approve'],
  },
  {
    icon: <GitPullRequestIcon className="size-4" />,
    title: 'Qualify leads from Switzerland too',
    meta: '#11 · sales-inbound · qualify-ch → main',
    actions: ['Request changes', 'Merge'],
  },
];

const MEMBERS = [
  { name: 'Owner 1', role: 'Owner' },
  { name: 'Member 2', role: 'Admin' },
  { name: 'Member 3', role: 'Member' },
  { name: 'Member 4', role: 'Member' },
];

function ReviewPage() {
  return (
    <Shell
      title="Review"
      description="Changes your agents propose and actions that wait for a person."
      filters={<Filters items={['Pending', 'Merged', 'Closed']} />}
    >
      <div className="grid grid-cols-[1fr_15rem] gap-5">
        <ul className="divide-y self-start rounded-lg border">
          {QUEUE.map((item) => (
            <li key={item.title} className="flex items-center gap-3 px-4 py-3.5">
              <span className="text-muted-foreground">{item.icon}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{item.title}</span>
                <span className="text-muted-foreground font-mono text-xs">{item.meta}</span>
              </span>
              <span className="ml-auto flex shrink-0 gap-2">
                <Button size="xs" variant="ghost" tabIndex={-1}>
                  {item.actions[0]}
                </Button>
                <Button size="xs" tabIndex={-1}>
                  {item.actions[1]}
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1 rounded-lg border p-3">
          <p className="text-muted-foreground px-1 pb-1 text-xs">Members</p>
          {MEMBERS.map((m) => (
            <div key={m.name} className="flex items-center gap-2.5 px-1 py-1.5">
              <span className="bg-muted flex size-7 items-center justify-center rounded-full text-xs font-medium">
                {m.name.split(' ').map((w) => w[0]).join('')}
              </span>
              <span className="text-sm">{m.name}</span>
              <span className="text-muted-foreground ml-auto text-xs">{m.role}</span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

const PAGES: Record<CustomizeTab, () => ReactNode> = {
  Connectors: ConnectorsPage,
  Triggers: TriggersPage,
  Review: ReviewPage,
};

export function CustomizeBoard({ tab }: { tab: CustomizeTab }) {
  const Page = PAGES[tab];
  return (
    <AppBoard nav="customize">
      <section aria-label="Customize" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar tab={tab} />
        <Page key={tab} />
      </section>
    </AppBoard>
  );
}
