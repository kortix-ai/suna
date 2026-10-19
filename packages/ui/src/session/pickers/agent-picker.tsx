'use client';

/**
 * Agent picker, controlled, over `session.agents`. `value` is the agent name,
 * or null for the project's default agent. Send passes the pick as `options.agent`.
 */

import { CaretUpDownIcon, CheckIcon, RobotIcon } from '@phosphor-icons/react';
import type { Agent } from '@kortix/sdk';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { MENU_INDICATOR, MENU_INDICATOR_ICON } from '../../primitives/menu-recipe';
import { useUiStrings } from '../../providers/ui-provider';

const TRIGGER = 'text-muted-foreground hover:text-foreground h-7 max-w-40 min-w-0 gap-1 px-2 text-xs';

export function AgentPicker({
  agents,
  value,
  onChange,
  defaultName,
}: {
  agents: readonly Agent[];
  value: string | null;
  onChange: (name: string | null) => void;
  /** The project's configured default agent, shown when nothing is picked. */
  defaultName?: string | null;
}) {
  const t = useUiStrings().chat;
  if (agents.length === 0) return null;
  const check = (on: boolean) => (
    <span className={MENU_INDICATOR}>{on && <CheckIcon className={MENU_INDICATOR_ICON} />}</span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger variant="transparent" className={TRIGGER} aria-label={t.agent}>
        <RobotIcon className="size-3.5 shrink-0" />
        <span className="truncate capitalize">{value ?? defaultName ?? t.defaultAgent}</span>
        <CaretUpDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex-1 capitalize">{defaultName ? t.defaultAgentNamed(defaultName) : t.defaultAgent}</span>
          {check(!value)}
        </DropdownMenuItem>
        {agents.map((a) => (
          <DropdownMenuItem key={a.name} onSelect={() => onChange(a.name)} className="items-start">
            <span className="min-w-0 flex-1">
              <span className="block truncate capitalize">{a.name}</span>
              {a.description && <span className="text-muted-foreground block truncate text-xs">{a.description}</span>}
            </span>
            {check(value === a.name)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
