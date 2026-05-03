'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { ProjectIcon } from '@/components/kortix/project-icon';

export type ProjectTab =
  | 'about'
  | 'tasks'       // v1
  | 'board'       // v2
  | 'milestones'  // v2
  | 'team'        // v2 (legacy — folded into Settings)
  | 'credentials' // v2 (legacy — folded into Settings)
  | 'triggers'    // v2 (legacy — folded into Settings)
  | 'channels'    // v2 (legacy — folded into Settings)
  | 'settings'    // v2
  | 'files'
  | 'sessions'
  | 'members';    // from main — v1 team-based-access

export interface ProjectHeaderProps {
  project: any;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onNewTask?: () => void;
  /** 2 for tickets/board, 1 (or undefined) for legacy. */
  structureVersion?: number;
  newActionLabel?: string;
  newActionHotkey?: string;
  /** Per-tab unread badge counts (currently only used for 'board'). */
  tabBadges?: Partial<Record<ProjectTab, number>>;
  /** Right-side slot — rendered between tabs and the New-task button. */
  rightSlot?: React.ReactNode;
}

const V1_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'about', label: 'About' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'members', label: 'Members' },
];

// Top-level tabs intentionally stay lean — 6 work surfaces users actually
// scan every visit. Rarely-touched configuration (team, credentials,
// triggers, board columns/fields/templates) lives inside Settings.
const V2_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'about', label: 'About' },
  { id: 'board', label: 'Board' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'settings', label: 'Settings' },
];

export function ProjectHeader({
  project,
  tab,
  onTabChange,
  onNewTask,
  structureVersion,
  newActionLabel,
  newActionHotkey,
  tabBadges,
  rightSlot,
}: ProjectHeaderProps) {
  const isV2 = structureVersion === 2;
  const tabs = isV2 ? V2_TABS : V1_TABS;
  const label = newActionLabel ?? (isV2 ? 'New ticket' : 'New task');
  const hotkey = newActionHotkey ?? 'C';
  return (
    <header className="shrink-0 border-b bg-background">
      <div className="container mx-auto flex h-12 max-w-7xl items-center gap-4 px-3 sm:px-4">
        <TabsPrimitive.Root
          value={tab}
          onValueChange={(v) => onTabChange(v as ProjectTab)}
          className="flex h-full flex-1 items-center gap-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <ProjectIcon project={project} size="xs" />
            <h1
              className="truncate text-sm font-semibold tracking-tight text-foreground"
              title={project.name}
            >
              {project.name}
            </h1>
            {isV2 && (
              <Badge
                variant="muted"
                size="sm"
                className="font-mono uppercase tracking-wider"
              >
                v2
              </Badge>
            )}
          </div>

          <TabsPrimitive.List className="flex h-full shrink-0 items-center gap-5">
            {tabs.map((t) => {
              const badge = tabBadges?.[t.id] ?? 0;
              return (
                <TabsPrimitive.Trigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    'relative inline-flex h-full cursor-pointer items-center gap-1.5 text-sm font-medium tracking-tight outline-none transition-colors',
                    'text-muted-foreground/70 hover:text-foreground',
                    'data-[state=active]:text-foreground',
                    'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground',
                    'after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100',
                  )}
                >
                  {t.label}
                  {badge > 0 && (
                    <Badge
                      variant="destructive"
                      size="sm"
                      className="rounded-full tabular-nums"
                      aria-label={`${badge} unread`}
                    >
                      {badge > 99 ? '99+' : badge}
                    </Badge>
                  )}
                </TabsPrimitive.Trigger>
              );
            })}
          </TabsPrimitive.List>

          <div className="flex flex-1 items-center justify-end gap-1.5">
            {rightSlot}
            {onNewTask && (
              <Button size="sm" onClick={onNewTask} title={`${label} (${hotkey})`}>
                <Plus />
                <span className="hidden sm:inline">{label}</span>
                <Kbd className="hidden border border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/90 sm:inline-flex">
                  {hotkey}
                </Kbd>
              </Button>
            )}
          </div>
        </TabsPrimitive.Root>
      </div>
    </header>
  );
}
