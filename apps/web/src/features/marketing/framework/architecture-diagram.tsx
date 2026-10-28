import { cn } from '@kortix/ui';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowsDownUpIcon,
  ArrowsLeftRightIcon,
  ArrowUpIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

/*
 * How Kortix works, end to end, as boxes on tokens: clients, the API (the
 * control plane), the session computer between the project repository and the
 * LLM gateway, and Drive under it. The numbered marks are the crossings of the
 * computer boundary; CROSSINGS explains each one, and the page lists them.
 *
 * Facts, each checked in the source named:
 * - docs/guide.mdx "Computers", "Security": one isolated computer per session,
 *   its own branch, /workspace, sleeps ~15–20 min after the last turn.
 * - harness/README.md: every new session runs pi inside kortixd; pi checks
 *   each tool call against the agent's permission policy (allow, ask, deny).
 * - docs/guide.mdx "Connectors", "Security": the API holds connector logins,
 *   applies Allow, Ask, Block, makes and records the call.
 * - docs/guide.mdx "Security": secret audiences and the enforced stand-in.
 * - docs/guide.mdx "Models": every model request goes through the gateway.
 * - docs/guide.mdx "Drive", api/src/memory/layers.ts: Memory folders in Drive,
 *   read with the folder's rights; feature-flags/registry.ts: Drive is on by
 *   default.
 */

type Glyph = ComponentType<{ className?: string }>;

const CLIENTS = [
  'Web app',
  'Desktop app',
  'Mobile app',
  'CLI and TUI',
  'Slack, Teams, Telegram',
  'MCP clients',
  'Your own app',
];

const API_MODULES = [
  { k: 'Projects and access', v: 'Members, groups and roles decide who may run which agent.' },
  { k: 'Sessions', v: 'Starts each session on its own computer.' },
  { k: 'Triggers', v: 'Schedules, webhooks and App events start sessions with nobody at the keyboard.' },
  { k: 'Connector broker', v: 'Holds every login, applies your rules, makes the call and records it.' },
  { k: 'Secrets', v: 'Encrypted values, each with an audience of people, groups or agents.' },
  { k: 'Review', v: 'Change requests and held actions wait here for a person.' },
  { k: 'Apps', v: 'Sites, services and backends that agents build and deploy.' },
  { k: 'Audit log', v: 'Who did what, whether it was allowed, and who an agent acted for.' },
];

const COMPUTER = [
  {
    k: 'kortixd',
    n: 1,
    v: 'The daemon runs the open-source pi coding agent and checks every tool call against the agent’s rules.',
  },
  { k: '/workspace', v: 'With repository access: the project, checked out on the session’s own branch.' },
  { k: '/drives', v: 'The Drive folders this session may open.' },
  { k: 'terminal, browser', v: 'Plus Python, Node.js and document tools.' },
];

const DRIVE = [
  { k: '/drives/me', v: 'Your own folder. It opens only in a private session you started.' },
  { k: 'Company', v: 'One folder every project member can open.' },
  { k: 'Shared folders', v: 'Any folder can be shared with people, groups and agents.' },
  { k: 'Memory', v: 'What the company knows, as Markdown files. Each Memory folder has its folder’s rights.' },
];

/** Every way work crosses the computer boundary, and what checks it. The numbers match the diagram's marks. */
export const CROSSINGS = [
  {
    n: 1,
    k: 'A tool call',
    v: 'kortixd checks the agent’s rule for the tool before it runs: Allow, Ask or Deny. Ask waits for a person. A rule can match one shell command or one file path.',
  },
  {
    n: 2,
    k: 'A connector call',
    v: 'The session asks the Kortix API. The broker picks the account, applies Allow, Ask or Block, makes the call and records it. The login never enters the computer.',
  },
  {
    n: 3,
    k: 'A secret',
    v: 'Each secret has an audience: the project, only you, or chosen people, groups or agents. An enforced secret reaches the computer as a stand-in worth nothing. Kortix swaps in the real value outside it, only on requests to the addresses you list.',
  },
  {
    n: 4,
    k: 'A model call',
    v: 'Every model request goes through the Kortix LLM gateway, which applies budgets and access rules and reports the cost.',
  },
  {
    n: 5,
    k: 'A change to the project',
    v: 'By default a session pushes only to its own branch. Its work reaches the shared repository when a person merges its change request on the Review page.',
  },
  {
    n: 6,
    k: 'A file in Drive',
    v: 'A session opens only the folders its agent may open, plus your own and those shared with you when you started it privately. Memory follows the same folder rights.',
  },
] as const;

/** A numbered crossing mark: the same number labels the arrow and the row that explains it. */
export function CrossingMark({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="text-foreground bg-background inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-xs tabular-nums"
    >
      {n}
    </span>
  );
}

function Tier({
  title,
  note,
  children,
  className,
}: {
  title: string;
  note: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('bg-background flex min-w-0 flex-col gap-4 rounded-lg border p-5 lg:p-6', className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-foreground text-base font-medium">{title}</h3>
        <p className="text-muted-foreground text-sm">{note}</p>
      </header>
      {children}
    </section>
  );
}

function Chips({ items, mono = false }: { items: readonly string[]; mono?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item}
          className={cn('bg-muted text-foreground rounded-md px-2.5 py-1 text-sm', mono && 'font-mono text-xs')}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Term / description cells split by hairlines, inside a tier. */
function Cells({ items, cols, mono = false }: { items: readonly { k: string; v: string }[]; cols: string; mono?: boolean }) {
  return (
    <dl className={cn('bg-border grid grid-cols-1 gap-px overflow-hidden rounded-md border sm:grid-cols-2', cols)}>
      {items.map((item) => (
        <div key={item.k} className="bg-background flex flex-col gap-1 p-4">
          <dt className={cn('text-foreground text-sm font-medium', mono && item.k.startsWith('/') && 'font-mono')}>
            {item.k}
          </dt>
          <dd className="text-muted-foreground text-sm text-pretty">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Labelled arrows between two tiers, centred. */
function Flows({ items }: { items: readonly { icon: Glyph; n?: number; label: ReactNode }[] }) {
  return (
    <ul className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-6 gap-y-2 py-4 text-xs">
      {items.map((item, i) => (
        <li key={i} className="flex items-center gap-2 text-center">
          {item.n ? <CrossingMark n={item.n} /> : null}
          <item.icon className="size-3.5 shrink-0" aria-hidden />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** A side link between two boxes: vertical on a phone, horizontal from `lg`. */
function SideLink({ n, icon: Icon, lgIcon: LgIcon, label }: { n: number; icon: Glyph; lgIcon: Glyph; label: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-xs lg:w-24 lg:flex-col lg:self-center lg:px-2 lg:py-0 lg:text-center">
      <CrossingMark n={n} />
      <Icon className="size-3.5 shrink-0 lg:hidden" aria-hidden />
      <LgIcon className="hidden size-3.5 shrink-0 lg:block" aria-hidden />
      <span className="text-pretty">{label}</span>
    </div>
  );
}

function Computer() {
  return (
    <div className="flex min-w-0 flex-col">
      <section className="bg-background flex flex-col gap-4 rounded-lg border border-dashed p-5 lg:p-6">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-foreground text-base font-medium">Session computer</h3>
          <p className="text-muted-foreground text-sm">one per session, isolated</p>
        </header>
        <p className="text-muted-foreground text-sm text-pretty">
          Every session runs one agent on its own cloud computer, with that agent’s permissions, not the permissions of
          the person who started it.
        </p>
        <dl className="divide-y border-y">
          {COMPUTER.map((row) => (
            <div key={row.k} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">
              <dt className="text-foreground flex items-center gap-2 font-mono text-xs">
                {row.k}
                {row.n ? <CrossingMark n={row.n} /> : null}
              </dt>
              <dd className="text-muted-foreground text-sm text-pretty sm:col-span-2">{row.v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-sm text-pretty">
          About 15 to 20 minutes after the last turn it sleeps. The next message wakes it with{' '}
          <code className="text-foreground font-mono text-xs">/workspace</code>, the branch and the conversation kept.
          The dashed edge is the policy boundary: every crossing is numbered.
        </p>
      </section>
      {/* One computer per session: the edges of the next sessions' computers. */}
      <div aria-hidden className="bg-background mx-3 h-1.5 rounded-b-lg border border-t-0" />
      <div aria-hidden className="bg-background mx-6 h-1.5 rounded-b-lg border border-t-0" />
    </div>
  );
}

export function ArchitectureDiagram() {
  return (
    <figure className="bg-card flex flex-col p-4 lg:p-8" aria-label="How Kortix works, end to end">
      <Tier title="Clients" note="People and code reach Kortix the same way">
        <Chips items={CLIENTS} />
        <p className="text-muted-foreground text-sm text-pretty">
          Your own app composes its experience with <code className="text-foreground font-mono text-xs">@kortix/sdk</code>{' '}
          and <code className="text-foreground font-mono text-xs">@kortix/ui</code>, the same client the Kortix web app
          uses.
        </p>
      </Tier>

      <Flows items={[{ icon: ArrowDownIcon, label: 'every client calls one API' }]} />

      <Tier title="Kortix API" note="The control plane: who may do what, and when">
        <Cells items={API_MODULES} cols="lg:grid-cols-4" />
      </Tier>

      <Flows
        items={[
          { icon: ArrowDownIcon, label: 'starts each session' },
          { icon: ArrowUpIcon, n: 2, label: 'connector calls go to the broker' },
          { icon: ArrowDownIcon, n: 3, label: 'secrets arrive by audience' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.5fr)_auto_minmax(0,1fr)] lg:items-start">
        <Tier title="Project repository" note="git, the source of truth">
          <Chips items={['kortix.yaml', 'agents/', 'skills/', 'tools/', 'memory/']} mono />
          <p className="text-muted-foreground text-sm text-pretty">
            Every agent, skill, tool and trigger is a file. Kortix hosts the repository, or you connect your own on
            GitHub.
          </p>
        </Tier>
        <SideLink n={5} icon={ArrowsDownUpIcon} lgIcon={ArrowsLeftRightIcon} label="own branch, change request" />
        <Computer />
        <SideLink n={4} icon={ArrowDownIcon} lgIcon={ArrowRightIcon} label="every model call" />
        <Tier title="LLM gateway" note="every model call">
          <Chips items={['Kortix-managed models', 'Your own keys', 'Fallbacks', 'Budgets', 'Logs']} />
          <p className="text-muted-foreground text-sm text-pretty">
            One place for models. When a model fails, the gateway tries up to 8 fallback models in order.
          </p>
        </Tier>
      </div>

      <Flows
        items={[
          {
            icon: ArrowsDownUpIcon,
            n: 6,
            label: (
              <>
                Drive folders open in the session at <code className="text-foreground font-mono">/drives</code>
              </>
            ),
          },
        ]}
      />

      <Tier title="Kortix Drive" note="Shared folders for people and agents">
        <Cells items={DRIVE} cols="lg:grid-cols-4" mono />
        <p className="text-muted-foreground text-sm text-pretty">
          Files in Drive outlive the session: they are kept until someone deletes them. People open the same folders
          from Drive in the web app, and each folder’s rights decide who reads it.
        </p>
      </Tier>
    </figure>
  );
}
