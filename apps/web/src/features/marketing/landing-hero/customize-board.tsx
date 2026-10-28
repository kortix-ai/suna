'use client';

import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Switch } from '@kortix/ui/switch';
import {
  ArrowUpRightIcon,
  ClockIcon,
  EnvelopeSimpleIcon,
  PlusIcon,
  ShieldCheckIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { SessionStatusMark } from './session-status-mark';
import { AppBoard } from './session-window';
import { useBeats } from './use-beats';

/**
 * The Customize page of the Arcadia project, drawn like the app's
 * (capability-tabs.tsx + capability-page-shell.tsx) inside the session
 * window's chrome. The hero's Workspace steps 2 and 3 play its Connectors
 * and Triggers tabs as short scenes. Every name is a synthetic Arcadia fixture.
 */

export type CustomizeTab = 'Connectors' | 'Triggers';

/** CAPABILITY_TABS in packages/ui/src/internal/lib/capability-tab-routes.ts; Members is a link. */
const TABS = [
  'Agents',
  'Skills',
  'Connectors',
  'Triggers',
  'Reminders',
  'Models',
  'Secrets',
  'Repo',
  'Review',
];

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
    mark: (
      <Image
        src={`${COLOR}/slack.svg`}
        alt=""
        width={20}
        height={20}
        unoptimized
        className="size-5"
      />
    ),
    detail: 'Built in',
  },
  {
    name: 'Email',
    mark: <EnvelopeSimpleIcon className="size-5" aria-hidden />,
    detail: 'Built in',
  },
  { name: 'Notion', mark: <BrandGlyph slug="notion" />, detail: 'kortix' },
];

/** The connector this step connects on screen. */
const CONNECTING = 'HubSpot';

const POLICY = ['Allow', 'Ask', 'Block'] as const;
type Policy = (typeof POLICY)[number];

/** LinkedIn's rules, as kortix.yaml sets them: `linkedin.create_*` asks first. */
const RULES: { tool: string; does: string; policy: Policy; from?: Policy }[] = [
  { tool: 'linkedin.get_profile', does: 'Reads a profile', policy: 'Allow' },
  { tool: 'linkedin.create_post', does: 'Publishes a post', policy: 'Ask', from: 'Allow' },
  { tool: 'linkedin.create_comment', does: 'Comments on a post', policy: 'Ask' },
  { tool: 'linkedin.delete_post', does: 'Deletes a post', policy: 'Block' },
];

/** Connectors beats: HubSpot connecting, connected, then one rule moves Allow → Ask. */
const CONNECTOR_BEATS = [900, 2100, 3600] as const;

/** A segmented Allow / Ask / Block control whose thumb slides to `value`. */
function PolicySwitch({ value }: { value: Policy }) {
  return (
    <span className="bg-muted relative ml-auto grid grid-cols-3 rounded-md p-0.5">
      <span
        aria-hidden
        className="bg-background duration-slower absolute inset-y-0.5 left-0.5 w-14 rounded-sm shadow-xs transition-transform ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${POLICY.indexOf(value) * 100}%)` }}
      />
      {POLICY.map((p) => (
        <span
          key={p}
          className={cn(
            'duration-slower relative flex h-6 w-14 items-center justify-center text-xs font-medium transition-colors',
            p === value ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {p}
        </span>
      ))}
    </span>
  );
}

function ConnectorsPage({ play }: { play: boolean }) {
  const beat = useBeats(play, CONNECTOR_BEATS);
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
        {CONNECTORS.map((c) => {
          const state =
            c.name !== CONNECTING || beat >= 2 ? 'connected' : beat >= 1 ? 'connecting' : 'idle';
          return (
            <li
              key={c.name}
              className={cn(
                'duration-slower flex items-center gap-3 rounded-lg border px-4 py-3.5 transition-colors ease-out',
                c.name === CONNECTING && beat >= 1 && beat < 3 ? 'bg-muted' : 'bg-card',
              )}
            >
              <span className="bg-background flex size-9 items-center justify-center rounded-md border">
                {c.mark}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{c.name}</span>
                <span className="text-muted-foreground truncate text-xs">{c.detail}</span>
              </span>
              {state === 'idle' ? (
                <Button size="xs" variant="outline" tabIndex={-1} className="ml-auto">
                  Connect
                </Button>
              ) : (
                <span
                  key={state}
                  className="text-muted-foreground animate-in fade-in duration-slower ml-auto flex items-center gap-1.5 text-xs ease-out"
                >
                  {state === 'connecting' ? (
                    <Loading className="size-3" />
                  ) : (
                    <span className="bg-kortix-green size-1.5 rounded-full" aria-hidden />
                  )}
                  {state === 'connecting' ? 'Connecting' : 'Connected'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 pt-3">
        <p className="text-sm font-medium">LinkedIn rules</p>
        <ul className="divide-y rounded-lg border">
          {RULES.map((rule) => {
            const moving = rule.from !== undefined;
            return (
              <li
                key={rule.tool}
                className={cn(
                  'duration-slower flex items-center gap-4 px-4 py-2.5 transition-colors ease-out',
                  moving && beat >= 3 && 'bg-muted',
                )}
              >
                <span className="w-60 font-mono text-xs">{rule.tool}</span>
                <span className="text-muted-foreground text-sm">{rule.does}</span>
                <PolicySwitch value={moving && beat < 3 ? rule.from! : rule.policy} />
              </li>
            );
          })}
        </ul>
      </div>
    </Shell>
  );
}

/** The three triggers in kortix.yaml, plus two schedules set in the app. The last one is added on screen. */
const TRIGGERS: { name: string; on: string; webhook?: boolean; agent: string; last: string }[] = [
  { name: 'New GitHub issue', on: 'Webhook', webhook: true, agent: 'eng-triage', last: '2h ago' },
  { name: 'Inbound lead', on: 'Webhook', webhook: true, agent: 'sales-inbound', last: '22m ago' },
  { name: 'Monday revenue report', on: 'Mondays at 08:00', agent: 'kortix', last: 'Mon 08:00' },
  {
    name: 'Month-end close',
    on: '1st of the month at 08:00',
    agent: 'kortix',
    last: 'Oct 1, 08:00',
  },
  {
    name: 'Weekly LinkedIn post',
    on: 'Tuesdays at 10:00',
    agent: 'marketing',
    last: 'Next: Tue 10:00',
  },
];

const ADDED = 'Weekly LinkedIn post';
const FIRES = 'New GitHub issue';

/** Triggers beats: the new schedule lands, then a webhook fires and its run starts. */
const TRIGGER_BEATS = [900, 3000] as const;

function TriggersPage({ play }: { play: boolean }) {
  const beat = useBeats(play, TRIGGER_BEATS);
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
      filters={
        <Filters items={['All', 'Schedules', 'Connector events', 'App events', 'Webhooks']} />
      }
    >
      <ul className="divide-y rounded-lg border">
        {TRIGGERS.map((t) => {
          const added = t.name === ADDED;
          const fired = t.name === FIRES && beat >= 2;
          return (
            <li
              key={t.name}
              className={cn(
                'duration-slower flex items-center gap-4 px-4 py-3.5 transition-[opacity,background-color] ease-out',
                added && beat < 1 && 'opacity-0',
                ((added && beat === 1) || fired) && 'bg-muted',
              )}
            >
              <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
                {t.webhook ? (
                  <WebhooksLogoIcon className="size-4" />
                ) : (
                  <ClockIcon className="size-4" />
                )}
              </span>
              <span className="flex w-64 flex-col">
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-muted-foreground text-xs">{t.on}</span>
              </span>
              <span className="text-muted-foreground font-mono text-xs">→ {t.agent}</span>
              <span
                key={fired ? 'run' : 'idle'}
                className="text-muted-foreground animate-in fade-in duration-slower ml-auto flex items-center gap-2 text-xs ease-out"
              >
                {fired ? <SessionStatusMark status="running" /> : null}
                {fired ? 'Running now' : t.last}
              </span>
              <Switch checked aria-label={`${t.name} is on`} tabIndex={-1} />
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

const PAGES: Record<CustomizeTab, (props: { play: boolean }) => ReactNode> = {
  Connectors: ConnectorsPage,
  Triggers: TriggersPage,
};

/** `play` starts the open tab's scene; a new tab mounts a new scene. */
export function CustomizeBoard({ tab, play }: { tab: CustomizeTab; play: boolean }) {
  const Page = PAGES[tab];
  return (
    <AppBoard nav="customize" framed={false}>
      <section aria-label="Customize" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar tab={tab} />
        <Page key={tab} play={play} />
      </section>
    </AppBoard>
  );
}
