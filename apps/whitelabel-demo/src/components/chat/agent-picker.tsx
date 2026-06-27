'use client';

/**
 * Agent picker — controlled, over a server-side agent list (`useVisibleAgents({
 * projectId })`). Same component on the new-session screen and the chat composer.
 * `value` is the agent name (or null = the project's default agent); `onChange`
 * sets it. The chosen name is passed to send as `options.agent`.
 */

import type { Agent } from '@kortix/sdk/opencode-client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Bot, Check, ChevronsUpDown } from 'lucide-react';

export function AgentPicker({
  agents,
  value,
  onChange,
  defaultName,
}: {
  agents: Agent[];
  value: string | null;
  onChange: (name: string | null) => void;
  /** The project's configured default agent — shown when nothing is picked. */
  defaultName?: string | null;
}) {
  if (agents.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-[150px] gap-1 px-2 text-xs text-muted-foreground">
          <Bot className="size-3.5 shrink-0" />
          <span className="truncate capitalize">{value ?? defaultName ?? 'Default agent'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem onClick={() => onChange(null)}>
          <span className="flex-1 text-sm capitalize">
            {defaultName ? `${defaultName} (default)` : 'Default agent'}
          </span>
          {!value && <Check className="size-4 shrink-0 text-brand" />}
        </DropdownMenuItem>
        {agents.map((a) => (
          <DropdownMenuItem key={a.name} onClick={() => onChange(a.name)} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm capitalize">{a.name}</div>
              {a.description && (
                <div className="truncate text-xs text-muted-foreground">{a.description}</div>
              )}
            </div>
            {value === a.name && <Check className="mt-0.5 size-4 shrink-0 text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
