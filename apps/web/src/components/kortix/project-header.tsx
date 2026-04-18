'use client';

/**
 * Project header — single compact row, underline tabs.
 *
 * v1 projects see the legacy layout: About · Tasks · Files · Sessions.
 * v2 projects see: About · Board · Team · Settings · Files · Sessions.
 */

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type ProjectTab =
  | 'about'
  | 'tasks'       // v1
  | 'board'       // v2
  | 'team'        // v2
  | 'settings'    // v2
  | 'files'
  | 'sessions';

export interface ProjectHeaderProps {
  project: any;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onNewTask?: () => void;
  /** 2 for tickets/board, 1 (or undefined) for legacy. */
  structureVersion?: number;
  newActionLabel?: string;
  newActionHotkey?: string;
}

const V1_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'about', label: 'About' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: 'Sessions' },
];

const V2_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'about', label: 'About' },
  { id: 'board', label: 'Board' },
  { id: 'team', label: 'Team' },
  { id: 'settings', label: 'Settings' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: 'Sessions' },
];

export function ProjectHeader({
  project,
  tab,
  onTabChange,
  onNewTask,
  structureVersion,
  newActionLabel,
  newActionHotkey,
}: ProjectHeaderProps) {
  const isV2 = structureVersion === 2;
  const tabs = isV2 ? V2_TABS : V1_TABS;
  const label = newActionLabel ?? (isV2 ? 'New ticket' : 'New task');
  const hotkey = newActionHotkey ?? 'C';
  return (
    <header className="shrink-0 border-b border-border/60 bg-background">
      <div className="container mx-auto max-w-7xl h-11 px-3 sm:px-4">
        <TabsPrimitive.Root
          value={tab}
          onValueChange={(v) => onTabChange(v as ProjectTab)}
          className="h-full flex items-center gap-4"
        >
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <h1
              className="text-[14px] font-semibold tracking-tight text-foreground truncate"
              title={project.name}
            >
              {project.name}
            </h1>
            {isV2 && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-mono">
                v2
              </span>
            )}
          </div>

          <TabsPrimitive.List className="flex items-center h-full gap-5 shrink-0">
            {tabs.map((t) => (
              <TabsPrimitive.Trigger
                key={t.id}
                value={t.id}
                className={cn(
                  'relative h-full inline-flex items-center text-[13px] font-medium tracking-tight cursor-pointer transition-colors outline-none',
                  'text-muted-foreground/60 hover:text-foreground',
                  'data-[state=active]:text-foreground',
                  'after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground after:rounded-full',
                  'after:opacity-0 data-[state=active]:after:opacity-100 after:transition-opacity',
                )}
              >
                {t.label}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>

          <div className="flex-1 flex items-center justify-end">
            {onNewTask && (
              <Button
                size="sm"
                onClick={onNewTask}
                title={`${label} (${hotkey})`}
                className="h-7 px-2.5 text-[12px] gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
                <kbd className="hidden sm:inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded border border-white/20 bg-white/10 text-[10px] font-mono font-medium leading-none text-white/90">
                  {hotkey}
                </kbd>
              </Button>
            )}
          </div>
        </TabsPrimitive.Root>
      </div>
    </header>
  );
}
