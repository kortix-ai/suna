import { cn } from '@kortix/ui';
import {
  ArrowDownIcon,
  ArrowsDownUpIcon,
  ArrowsLeftRightIcon,
  ArrowUpIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

/*
 * How Kortix works, end to end, as boxes on tokens: clients, the API (the
 * control plane), the session computer between the project repository and the
 * LLM gateway, and Drive under it. The boxes hold names only; PARTS explains
 * each box under the diagram. The numbered marks are the crossings of the
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
 * - docs/guide.mdx "Models": every model request goes through the gateway,
 *   up to 8 fallback models in order.
 * - docs/guide.mdx "Drive", api/src/memory/layers.ts: Memory folders in Drive,
 *   read with the folder's rights; feature-flags/registry.ts: Drive is on by
 *   default.
 */

type Glyph = ComponentType<{ className?: string }>;
type Chip = string | { label: string; n: number };

const CLIENTS = ['Web app', 'Desktop app', 'Mobile app', 'CLI and TUI', 'Slack, Teams, Telegram', 'MCP clients', 'Your own app'];
const API_MODULES = ['Projects and access', 'Sessions', 'Triggers', 'Connector broker', 'Secrets', 'Review', 'Apps', 'Audit log'];
const REPOSITORY = ['kortix.yaml', 'agents/', 'skills/', 'tools/', 'memory/'];
const COMPUTER: Chip[] = [{ label: 'kortixd', n: 1 }, 'pi', '/workspace', '/drives', 'terminal', 'browser'];
const GATEWAY = ['Kortix-managed models', 'Your own keys', 'Fallbacks', 'Budgets', 'Logs'];
const DRIVE = ['/drives/me', 'Company', 'Shared folders', 'Memory'];

const code = (text: string) => <code className="text-foreground font-mono text-xs">{text}</code>;

/** What each box of the diagram is, for the rows under it. */
export const PARTS: readonly { id: string; k: string; v: ReactNode }[] = [
  {
    id: 'api',
    k: 'Kortix API',
    v: 'The control plane. Members, groups and roles decide who may run which agent. Triggers start sessions with nobody at the keyboard. Review holds change requests and held actions for a person. Apps are the sites, services and backends agents build and deploy. The audit log records who did what.',
  },
  {
    id: 'computer',
    k: 'Session computer',
    v: (
      <>
        Every session runs one agent on its own cloud computer. kortixd runs the open-source pi coding agent. With
        repository access, {code('/workspace')} holds the project on the session’s own branch. {code('/drives')} holds
        the Drive folders the session may open. A terminal, a browser, Python, Node.js and document tools come with it.
        About 15 to 20 minutes after the last turn it sleeps. The next message wakes it with {code('/workspace')}, the
        branch and the conversation kept.
      </>
    ),
  },
  {
    id: 'repository',
    k: 'Project repository',
    v: 'git, the source of truth. Every agent, skill, tool and trigger is a file. Kortix hosts the repository, or you connect your own on GitHub.',
  },
  {
    id: 'gateway',
    k: 'LLM gateway',
    v: 'One place for models: Kortix-managed models or your own keys, with budgets and logs. When a model fails, the gateway tries up to 8 fallback models in order.',
  },
  {
    id: 'drive',
    k: 'Kortix Drive',
    v: (
      <>
        Shared folders for people and agents. {code('/drives/me')} is your own folder. Company is one folder every
        project member can open, and any folder can be shared with people, groups and agents. Memory is what the
        company knows, as Markdown files. Files in Drive outlive the session, and people open the same folders from
        Drive in the web app.
      </>
    ),
  },
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

/** One box: a name, one short note, then chips. */
function Box({
  title,
  note,
  items,
  dashed = false,
  className,
}: {
  title: string;
  note: string;
  items: readonly Chip[];
  dashed?: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn('bg-background flex min-w-0 flex-col gap-5 rounded-lg border p-6', dashed && 'border-dashed', className)}
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-foreground text-base font-medium">{title}</h3>
        <p className="text-muted-foreground text-sm">{note}</p>
      </header>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const label = typeof item === 'string' ? item : item.label;
          const literal = /[./]/.test(label) || label === 'kortixd';
          return (
            <li
              key={label}
              className={cn(
                'bg-muted text-foreground flex items-center gap-2 rounded-md px-2.5 py-1 text-sm',
                literal && 'font-mono text-xs',
              )}
            >
              {label}
              {typeof item === 'string' ? null : <CrossingMark n={item.n} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Labelled arrows between two rows, centred. */
function Flows({ items }: { items: readonly { icon: Glyph; n?: number; label: ReactNode }[] }) {
  return (
    <ul className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-10 gap-y-3 py-6 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex items-center gap-2">
          {item.n ? <CrossingMark n={item.n} /> : null}
          <item.icon className="size-4 shrink-0" aria-hidden />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** A side link between two boxes: vertical on a phone, horizontal from `lg`. */
function SideLink({ n, label }: { n: number; label: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm lg:w-28 lg:flex-col lg:self-center lg:px-2 lg:py-0 lg:text-center">
      <CrossingMark n={n} />
      <ArrowsDownUpIcon className="size-4 shrink-0 lg:hidden" aria-hidden />
      <ArrowsLeftRightIcon className="hidden size-4 shrink-0 lg:block" aria-hidden />
      <span className="text-pretty">{label}</span>
    </div>
  );
}

export function ArchitectureDiagram() {
  return (
    <figure className="bg-card flex flex-col px-4 py-8 lg:p-12" aria-label="How Kortix works, end to end">
      <Box title="Clients" note="People and code reach Kortix the same way" items={CLIENTS} />

      <Flows items={[{ icon: ArrowDownIcon, label: 'every client calls one API' }]} />

      <Box title="Kortix API" note="The control plane: who may do what, and when" items={API_MODULES} />

      <Flows
        items={[
          { icon: ArrowDownIcon, label: 'starts each session' },
          { icon: ArrowUpIcon, n: 2, label: 'connector calls' },
          { icon: ArrowDownIcon, n: 3, label: 'secrets, by audience' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)_auto_minmax(0,1fr)]">
        <Box title="Project repository" note="git, the source of truth" items={REPOSITORY} />
        <SideLink n={5} label="own branch, change request" />
        <div className="flex min-w-0 flex-col">
          <Box
            title="Session computer"
            note="One per session. The dashed edge is the policy boundary."
            items={COMPUTER}
            dashed
            className="flex-1"
          />
          {/* One computer per session: the edges of the next sessions' computers. */}
          <div aria-hidden className="bg-background mx-3 h-1.5 rounded-b-lg border border-t-0" />
          <div aria-hidden className="bg-background mx-6 h-1.5 rounded-b-lg border border-t-0" />
        </div>
        <SideLink n={4} label="model calls" />
        <Box title="LLM gateway" note="One place for models" items={GATEWAY} />
      </div>

      <Flows
        items={[
          {
            icon: ArrowsDownUpIcon,
            n: 6,
            label: <>Drive folders open at {code('/drives')}</>,
          },
        ]}
      />

      <Box title="Kortix Drive" note="Shared folders for people and agents" items={DRIVE} />
    </figure>
  );
}
