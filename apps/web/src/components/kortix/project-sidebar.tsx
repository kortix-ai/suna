'use client';

import {
  Boxes,
  CircleDot,
  FolderTree,
  MessageSquareText,
  Plus,
  Settings,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { ProjectIcon } from '@/components/kortix/project-icon';
import type { ProjectTab } from '@/components/kortix/project-header';

interface SidebarItem {
  id: ProjectTab;
  label: string;
  icon: typeof CircleDot;
}

const V1_NAV: SidebarItem[] = [
  { id: 'about', label: 'Overview', icon: Sparkles },
  { id: 'tasks', label: 'Tasks', icon: CircleDot },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'sessions', label: 'Sessions', icon: MessageSquareText },
  { id: 'members', label: 'Members', icon: Users },
];

const V2_NAV: SidebarItem[] = [
  { id: 'about', label: 'Overview', icon: Sparkles },
  { id: 'board', label: 'Board', icon: Boxes },
  { id: 'milestones', label: 'Milestones', icon: Target },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'sessions', label: 'Sessions', icon: MessageSquareText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export interface ProjectSidebarProps {
  project: { id: string; name: string; path?: string; structure_version?: number };
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onNewTask?: () => void;
  newActionLabel?: string;
  newActionHotkey?: string;
  tabBadges?: Partial<Record<ProjectTab, number>>;
  footerSlot?: React.ReactNode;
}

export function ProjectSidebar({
  project,
  tab,
  onTabChange,
  onNewTask,
  newActionLabel,
  newActionHotkey,
  tabBadges,
  footerSlot,
}: ProjectSidebarProps) {
  const isV2 = project.structure_version === 2;
  const items = isV2 ? V2_NAV : V1_NAV;
  const ctaLabel = newActionLabel ?? (isV2 ? 'New ticket' : 'New task');
  const ctaKey = newActionHotkey ?? 'C';
  const cleanPath =
    project.path && project.path !== '/' && project.path !== '/workspace'
      ? project.path
      : '/workspace';

  return (
    <aside className="m-3 flex w-60 shrink-0 flex-col overflow-hidden rounded-2xl border bg-muted/40">
      <div className="px-3 pt-4">
        <div className="flex items-center gap-3">
          <ProjectIcon project={project} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h2
                className="truncate text-sm font-semibold tracking-tight text-foreground"
                title={project.name}
              >
                {project.name}
              </h2>
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
            <p
              className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
              title={cleanPath}
            >
              ~{cleanPath}
            </p>
          </div>
        </div>

        {onNewTask && (
          <Button
            size="sm"
            onClick={onNewTask}
            className="mt-4 w-full justify-start"
            title={`${ctaLabel} (${ctaKey})`}
          >
            <Plus />
            <span className="flex-1 text-left">{ctaLabel}</span>
            <Kbd className="border border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/90">
              {ctaKey}
            </Kbd>
          </Button>
        )}
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto px-2">
        {items.map((item) => {
          const isActive = tab === item.id;
          const badge = tabBadges?.[item.id] ?? 0;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              <Icon
                className={cn(
                  'size-4 shrink-0 transition-colors',
                  isActive ? 'text-foreground' : 'text-muted-foreground/60 group-hover:text-muted-foreground',
                )}
              />
              <span className="flex-1 truncate">{item.label}</span>
              {badge > 0 && (
                <Badge
                  variant="destructive"
                  size="sm"
                  className="rounded-full tabular-nums"
                >
                  {badge > 99 ? '99+' : badge}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>

      {footerSlot && (
        <div className="px-2 pb-2 pt-2">{footerSlot}</div>
      )}
    </aside>
  );
}
