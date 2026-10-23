'use client';

import {
  BookOpenIcon,
  CaretRightIcon,
  GearSixIcon,
  KeyIcon,
  LightningIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldCheckIcon,
  SlidersIcon,
  type Icon,
} from '@phosphor-icons/react';

import { capabilityTabHref, type CapabilityTab } from '../../internal/lib/capability-tab-routes';
import { cn } from '../../internal/lib/utils';
import { Label } from '../../primitives/label';
import { UiLink as Link } from '../../providers/ui-provider';

interface AdminItem {
  key: CapabilityTab['key'];
  label: string;
  description: string;
  icon: Icon;
}
interface AdminGroup {
  label: string;
  items: AdminItem[];
}

/**
 * The per-project admin environment: the project's backend configuration
 * (agents, automation, connections, knowledge, governance) grouped and pulled
 * out of day-to-day agent/session usage. Each row links the existing
 * capability page; the hub only reorganizes and separates them.
 *
 * Black-first: the hub pins `data-theme="dark"` on its own wrapper so the admin
 * env reads as a distinct, console-like surface regardless of the app theme,
 * while still drawing every value from the dark token set.
 */
const GROUPS: AdminGroup[] = [
  {
    label: 'Agents',
    items: [
      { key: 'agent', label: 'Agents', description: 'The agents this project runs, grouped by domain.', icon: RobotIcon },
    ],
  },
  {
    label: 'Automation',
    items: [
      { key: 'triggers', label: 'Automations', description: 'Cron, webhook and event triggers.', icon: LightningIcon },
      { key: 'reminders', label: 'Reminders', description: 'Scheduled, one-off session nudges.', icon: SlidersIcon },
    ],
  },
  {
    label: 'Connections',
    items: [
      { key: 'connectors', label: 'Connectors', description: 'Managed APIs and channels the agents reach.', icon: PlugsConnectedIcon },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { key: 'skills', label: 'Skills', description: 'Reusable skills agents can load.', icon: BookOpenIcon },
      { key: 'files', label: 'Repo', description: 'The project repository and its files.', icon: BookOpenIcon },
    ],
  },
  {
    label: 'Governance',
    items: [
      { key: 'secrets', label: 'Secrets', description: 'Encrypted values agents may read.', icon: KeyIcon },
      { key: 'models', label: 'Models', description: 'Model access and defaults.', icon: SlidersIcon },
      { key: 'review', label: 'Review', description: 'Changes waiting on a decision.', icon: ShieldCheckIcon },
      { key: 'config', label: 'Settings', description: 'Project configuration.', icon: GearSixIcon },
    ],
  },
];

export function ProjectAdminHub({ projectId }: { projectId: string }) {
  return (
    <div data-theme="dark" className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-10 px-4 py-10 pb-20 lg:py-16">
          <header className="space-y-1">
            <h1 className="text-foreground text-xl font-medium tracking-tight">Project admin</h1>
            <p className="text-muted-foreground text-sm text-balance">
              Configure this project&apos;s backend — agents, automation, connections and governance — apart from day-to-day use.
            </p>
          </header>

          {GROUPS.map((group) => (
            <section key={group.label} className="space-y-3">
              <Label>{group.label}</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.items.map((item) => (
                  <Link
                    key={item.key}
                    href={capabilityTabHref(projectId, item.key)}
                    className={cn(
                      'group bg-popover hover:border-foreground/20 flex items-center gap-3 rounded-md border px-4 py-3',
                      'transition-colors',
                    )}
                  >
                    <span className="bg-muted-foreground/10 text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
                      <item.icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">{item.label}</span>
                      <span className="text-muted-foreground block truncate text-xs">{item.description}</span>
                    </span>
                    <CaretRightIcon className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
