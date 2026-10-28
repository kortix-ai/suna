import { cn } from '@kortix/ui';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

/*
 * How Kortix fits together, as boxes on tokens. Facts: AGENTS.md (the stack,
 * the SDK, the session runtime), the docs sections Computers, Connectors,
 * Models and Apps. Connector credentials are brokered by the API and never
 * enter the session computer; every model call goes through the LLM gateway;
 * every new session runs pi inside kortixd on its own computer, on its own
 * branch of the project repository.
 */

const CLIENTS = ['Web app', 'Desktop', 'Mobile', 'CLI', 'Slack, Teams, email', 'MCP clients', 'Your app'];

const API = [
  'Projects and access',
  'Sessions',
  'Connectors',
  'Secrets',
  'Triggers and workers',
  'Review',
  'Apps',
  'Drive',
];

function Layer({ title, note, children, className }: { title: string; note: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-background flex flex-col gap-4 rounded-lg border p-5 lg:p-6', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-foreground text-base font-medium">{title}</h3>
        <p className="text-muted-foreground text-sm">{note}</p>
      </div>
      {children}
    </div>
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

function Flow({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-3 font-mono text-xs">
      <ArrowDownIcon className="size-3.5" aria-hidden />
      {children}
    </div>
  );
}

export function ArchitectureDiagram() {
  return (
    <figure className="bg-card flex flex-col p-4 lg:p-8" aria-label="How Kortix fits together">
      <Layer title="Clients" note="People and code reach Kortix the same way">
        <Chips items={CLIENTS} />
        <p className="text-muted-foreground text-sm">
          Your app composes its own experience with <code className="text-foreground font-mono text-xs">@kortix/sdk</code> and{' '}
          <code className="text-foreground font-mono text-xs">@kortix/ui</code>.
        </p>
      </Layer>
      <Flow>one HTTPS API, one token</Flow>
      <Layer title="Kortix API" note="The control plane: who may do what, and when">
        <Chips items={API} />
        <p className="text-muted-foreground text-sm">
          Connector credentials stay here. Triggers start sessions on a schedule, a webhook or an app event, with
          nobody at the keyboard.
        </p>
      </Layer>
      <Flow>starts a session, brokers every connector call</Flow>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Layer title="Project repository" note="git, the source of truth">
          <Chips items={['kortix.yaml', 'agents/', 'skills/', 'memory/', 'tools/']} mono />
          <p className="text-muted-foreground text-sm">
            Every agent, skill, tool and trigger is a file. A change lands through a change request a person merges.
          </p>
        </Layer>
        <Layer title="Session computer" note="one per session">
          <Chips items={['kortixd', 'pi coding agent', '/workspace', 'terminal', 'browser']} mono />
          <p className="text-muted-foreground text-sm">
            The daemon runs the open-source pi coding agent on the session&apos;s own branch. It sleeps when idle and
            wakes on the next message.
          </p>
        </Layer>
        <Layer title="LLM gateway" note="every model call">
          <Chips items={['Your keys', 'Kortix-managed models', 'Budgets', 'Logs']} />
          <p className="text-muted-foreground text-sm">
            One place for models: any provider with your own key, routing, fallbacks and spend limits.
          </p>
        </Layer>
      </div>
      <p className="text-muted-foreground pt-4 text-center font-mono text-xs">
        session → repository: checks out its branch, opens a change request · session → gateway: every model call
      </p>
    </figure>
  );
}
