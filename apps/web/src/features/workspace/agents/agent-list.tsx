'use client';

/**
 * The master half of the Agents master-detail split: a flat, self-scrolling
 * list of every agent in the project.
 *
 * It carries no search field of its own — search lives once, top-right in the
 * ProjectSectionPage header, and this list renders whatever it is handed. That
 * is the rail-inside-rail removal: one search, one list, one detail.
 */

import { Badge } from '@/components/ui/badge';
import { formatMode } from '@/features/workspace/customize/shared/utils';
import { cn } from '@/lib/utils';
import { StarSolid } from '@mynaui/icons-react';

export interface AgentListEntry {
  name: string;
  path: string;
  description: string | null;
  mode?: string | null;
  enabled?: boolean;
}

export function AgentList<T extends AgentListEntry>({
  agents,
  selectedPath,
  defaultAgentName,
  onSelect,
  emptyMessage = 'No agents match that search.',
}: {
  agents: T[];
  selectedPath: string | null;
  /** The project default — marked with a star, matching the detail badge. */
  defaultAgentName?: string | null;
  onSelect: (path: string) => void;
  emptyMessage?: string;
}) {
  return (
    <aside className="border-border/60 flex shrink-0 flex-col border-b lg:h-full lg:min-h-0 lg:w-[264px] lg:border-r lg:border-b-0">
      {agents.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">{emptyMessage}</p>
      ) : (
        <nav
          aria-label="Agents list"
          className="scrollbar-minimal px-2 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        >
          <ul className="space-y-0.5">
            {agents.map((agent) => {
              const isActive = selectedPath === agent.path;
              return (
                <li key={agent.path}>
                  <button
                    type="button"
                    onClick={() => onSelect(agent.path)}
                    aria-current={isActive}
                    className={cn(
                      'group flex w-full flex-col gap-0.5 rounded-md py-2 pr-2.5 pl-3 text-left transition-colors',
                      'focus-visible:ring-kortix-blue/50 focus-visible:ring-2 focus-visible:outline-none',
                      isActive ? 'bg-primary/[0.06]' : 'hover:bg-muted/40',
                      agent.enabled === false && 'opacity-60',
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm font-medium',
                          isActive
                            ? 'text-foreground'
                            : 'text-foreground/70 group-hover:text-foreground',
                        )}
                      >
                        {agent.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {agent.mode ? (
                          <Badge variant="muted" size="xs">
                            {formatMode(agent.mode)}
                          </Badge>
                        ) : null}
                        {defaultAgentName === agent.name ? (
                          <StarSolid
                            aria-label="Project default"
                            className="text-kortix-orange size-4 shrink-0 fill-current"
                          />
                        ) : null}
                      </span>
                    </span>
                    {agent.description ? (
                      <span className="text-muted-foreground/60 w-full truncate text-xs">
                        {agent.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </aside>
  );
}

export default AgentList;
