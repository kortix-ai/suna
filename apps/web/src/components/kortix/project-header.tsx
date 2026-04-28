'use client';

import { useCallback, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import {
  Plus,
  Sparkles,
  Boxes,
  Flag,
  FolderOpen,
  MessageSquareText,
  Settings as SettingsIcon,
  ListChecks,
  Users as UsersIcon,
  Check,
  Copy,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProjectIcon } from '@/components/kortix/project-icon';

export type ProjectTab =
  | 'about'
  | 'tasks'
  | 'board'
  | 'milestones'
  | 'team'
  | 'credentials'
  | 'triggers'
  | 'channels'
  | 'settings'
  | 'files'
  | 'sessions'
  | 'members';

export interface ProjectHeaderProps {
  project: any;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onNewTask?: () => void;
  structureVersion?: number;
  newActionLabel?: string;
  newActionHotkey?: string;
  tabBadges?: Partial<Record<ProjectTab, number>>;
  rightSlot?: React.ReactNode;
  isLive?: boolean;
}

type TabDef = { id: ProjectTab; label: string; icon: LucideIcon };

const V1_TABS: TabDef[] = [
  { id: 'about', label: 'About', icon: Sparkles },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'sessions', label: 'Sessions', icon: MessageSquareText },
  { id: 'members', label: 'Members', icon: UsersIcon },
];

const V2_TABS: TabDef[] = [
  { id: 'about', label: 'Overview', icon: Sparkles },
  { id: 'board', label: 'Board', icon: Boxes },
  { id: 'milestones', label: 'Milestones', icon: Flag },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'sessions', label: 'Sessions', icon: MessageSquareText },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
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
  isLive,
}: ProjectHeaderProps) {
  const isV2 = structureVersion === 2;
  const tabs = isV2 ? V2_TABS : V1_TABS;
  const label = newActionLabel ?? (isV2 ? 'New ticket' : 'New task');
  const hotkey = newActionHotkey ?? 'C';

  const cleanPath =
    project?.path && project.path !== '/' && project.path !== '/workspace'
      ? project.path
      : '/workspace';

  return (
    <header className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-7xl px-4 pt-6 pb-3 sm:px-6">
        <div className="flex items-start gap-4">
          <ProjectIcon project={project} size="md" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1
                className="truncate text-lg font-semibold leading-tight tracking-tight text-foreground"
                title={project.name}
              >
                {project.name}
              </h1>
              {isLive && <LivePulse />}
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

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/85">
              <PathButton path={cleanPath} fullPath={project.path} />
              {project?.created_at && (
                <>
                  <span className="text-muted-foreground/30">·</span>
                  <span>Created {relativeShort(project.created_at)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
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
        </div>
      </div>

      <div className="border-b border-border/50">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <TabsPrimitive.Root
            value={tab}
            onValueChange={(v) => onTabChange(v as ProjectTab)}
          >
            <TabsPrimitive.List className="-mb-px flex h-10 items-center gap-1">
              {tabs.map((t) => {
                const badge = tabBadges?.[t.id] ?? 0;
                const Icon = t.icon;
                return (
                  <TabsPrimitive.Trigger
                    key={t.id}
                    value={t.id}
                    className={cn(
                      'relative inline-flex h-full cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-sm font-medium tracking-tight outline-none transition-colors',
                      'text-muted-foreground/70 hover:text-foreground',
                      'data-[state=active]:text-foreground',
                      'after:absolute after:inset-x-2.5 after:-bottom-px after:h-[2px] after:rounded-full after:bg-foreground',
                      'after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100',
                      'focus-visible:ring-2 focus-visible:ring-ring/30',
                    )}
                  >
                    <Icon className="size-3.5" />
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
          </TabsPrimitive.Root>
        </div>
      </div>
    </header>
  );
}

function PathButton({ path, fullPath }: { path: string; fullPath?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!fullPath) return;
    navigator.clipboard.writeText(fullPath).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [fullPath]);
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground"
      title="Copy path"
    >
      <span>~{path}</span>
      {copied ? (
        <Check className="size-3 text-emerald-500" />
      ) : (
        <Copy className="size-3 opacity-40" />
      )}
    </button>
  );
}

function LivePulse() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex items-center justify-center">
          <span className="absolute size-2.5 animate-ping rounded-full bg-emerald-500/40" />
          <span className="relative size-1.5 rounded-full bg-emerald-500" />
        </span>
      </TooltipTrigger>
      <TooltipContent>An agent is working right now</TooltipContent>
    </Tooltip>
  );
}

function relativeShort(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = 60_000, h = m * 60, d = h * 24;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.round(diff / m)}m ago`;
  if (diff < d) return `${Math.round(diff / h)}h ago`;
  if (diff < d * 30) return `${Math.round(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}
