'use client';

import { useState } from 'react';

import { CaretRightIcon, StackSimpleIcon } from '@phosphor-icons/react';

import { groupByDomain } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';

import { cn } from '../../lib/utils';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '../../primitives/sidebar';
import { useActiveDomain } from '../../internal/stores/active-domain-store';

/**
 * Spaces — a collapsible section in the project sidebar that lists the project's
 * domains as spaces. Selecting one sets the active space (`active-domain-store`);
 * the whole workspace then scopes to it: which agents you can start, the
 * sessions you see, and Customize. `All spaces` clears the scope. Renders
 * nothing until the project declares a domain, so a plain project is unchanged.
 */
export function ProjectSpacesNav({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const [active, setActive] = useActiveDomain(projectId);
  const [open, setOpen] = useState(true);

  const groups = groupByDomain(config?.agents ?? [], config?.domains);
  const spaces = groups.filter((group) => !group.isDefault);
  if (spaces.length === 0) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group/menu-button text-sidebar-foreground"
        >
          <span className="shrink-0">
            <StackSimpleIcon />
          </span>
          <span className="truncate">Spaces</span>
          <CaretRightIcon
            weight="bold"
            className={cn(
              'text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open ? (
        <SidebarMenuSub>
          <SpaceRow label="All spaces" selected={active === null} onSelect={() => setActive(null)} />
          {spaces.map((space) => (
            <SpaceRow
              key={space.name}
              label={space.label}
              count={space.items.length}
              selected={active === space.name}
              onSelect={() => setActive(space.name)}
            />
          ))}
        </SidebarMenuSub>
      ) : null}
    </>
  );
}

function SpaceRow({
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
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={selected}>
        <button type="button" onClick={onSelect}>
          <span className="truncate">{label}</span>
          {count !== undefined ? (
            <span className="text-muted-foreground ml-auto tabular-nums">{count}</span>
          ) : null}
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
