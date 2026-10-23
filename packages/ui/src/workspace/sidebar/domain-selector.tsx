'use client';

import { CaretUpDownIcon, CheckIcon } from '@phosphor-icons/react';

import { groupByDomain } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { useActiveDomain } from '../../internal/stores/active-domain-store';

/** The sentinel label for "no scope — every domain". */
const ALL_LABEL = 'All domains';

/**
 * The domain switcher at the top of the project sidebar. Picks the active
 * domain (the space the user works inside); Customize and the surfaces that opt
 * in then scope to it. Renders nothing until the project declares a domain, so
 * a project that never uses domains keeps the plain sidebar.
 *
 * The list of domains comes from the same `groupByDomain` the Agents page uses,
 * so the switcher and the page always agree on which domains exist, their order
 * and their labels. The default/General bucket is offered only when something
 * actually lives in it.
 */
export function DomainSelector({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const [active, setActive] = useActiveDomain(projectId);

  const agents = config?.agents ?? [];
  const groups = groupByDomain(agents, config?.domains);
  const hasDomains = groups.some((group) => !group.isDefault);
  if (!hasDomains) return null;

  const current = active ? (groups.find((group) => group.name === active)?.label ?? active) : ALL_LABEL;

  return (
    <div className="px-2 pt-2">
      <span className="text-muted-foreground px-2 text-xs font-medium">Domain</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="border-border bg-popover hover:bg-accent mt-1 flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors"
          aria-label="Switch domain"
        >
          <span className="text-foreground flex-1 truncate text-sm font-medium">{current}</span>
          <CaretUpDownIcon className="text-muted-foreground size-4 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[14rem]">
          <DomainRow label={ALL_LABEL} selected={active === null} onSelect={() => setActive(null)} />
          {groups.map((group) => (
            <DomainRow
              key={group.name}
              label={group.label}
              count={group.items.length}
              selected={active === group.name}
              onSelect={() => setActive(group.name)}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DomainRow({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem size="sm" onSelect={onSelect} className="flex items-center gap-2">
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground tabular-nums">{count}</span>
      ) : null}
      {selected ? <CheckIcon className="size-4 shrink-0" weight="bold" /> : null}
    </DropdownMenuItem>
  );
}
