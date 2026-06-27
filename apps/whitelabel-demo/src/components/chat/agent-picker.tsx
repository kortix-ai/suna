'use client';

/**
 * Agent picker — the sibling of the model picker. Reads the resolved agent
 * surface from `useOpenCodeLocal().agent` (current + list + set) and lets the
 * user switch which agent handles the next message. The chosen `agent.current.name`
 * is passed to send as `options.agent`.
 */

import type { OpenCodeLocalAgent } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Bot, Check, ChevronsUpDown } from 'lucide-react';

export function AgentPicker({ agent }: { agent: OpenCodeLocalAgent }) {
  const list = agent.list ?? [];
  const current = agent.current;
  if (list.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-[150px] gap-1 px-2 text-xs text-muted-foreground">
          <Bot className="size-3.5 shrink-0" />
          <span className="truncate">{current?.name ?? 'Agent'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {list.map((a) => (
          <DropdownMenuItem
            key={a.name}
            onClick={() => agent.set(a.name)}
            className="flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm capitalize">{a.name}</div>
              {a.description && (
                <div className="truncate text-xs text-muted-foreground">{a.description}</div>
              )}
            </div>
            {current?.name === a.name && <Check className="mt-0.5 size-4 shrink-0 text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
