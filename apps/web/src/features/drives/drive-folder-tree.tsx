'use client';

import type { Drive } from '@kortix/sdk';
import { useDriveFolder } from '@kortix/ui/files';
import { Home } from '@kortix/ui/internal/icons/home';
import { Skeleton } from '@kortix/ui/skeleton';
import { cn } from '@kortix/ui';
import { CaretRightIcon, FolderSimpleIcon, HardDriveIcon, HashIcon } from '@phosphor-icons/react';
import { type ComponentType, type ReactNode, useEffect, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

/** `/a/b/c` → `['/a', '/a/b', '/a/b/c']`. */
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

/**
 * The Drive as one tree, beside the folder in view: the project at the top,
 * then every folder the caller may open, as it is stored (Company, Users,
 * Channels, team folders). A folder lists its children when it is expanded;
 * the folders on the way to the one in view are expanded by themselves.
 */
export function DriveFolderTree({
  drive,
  rootLabel,
  path,
  onOpen,
}: {
  drive: Drive;
  rootLabel: string;
  path: string;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['/', ...ancestors(path)]));
  // Moving to a folder (from the grid, a link, the breadcrumb) opens its way here too.
  useEffect(() => {
    setExpanded((prev) => {
      const way = ancestors(path).slice(0, -1);
      if (way.every((p) => prev.has(p))) return prev;
      return new Set([...prev, ...way]);
    });
  }, [path]);
  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <nav aria-label={t('folderTree')} className="border-border hidden w-64 shrink-0 overflow-y-auto border-r p-2 md:block">
      <ul role="tree" className="space-y-0.5">
        <TreeRow
          path="/"
          name={rootLabel}
          icon={HardDriveIcon}
          current={path}
          expanded={expanded}
          onToggle={toggle}
          onOpen={onOpen}
        >
          <TreeChildren drive={drive} parent="/" current={path} expanded={expanded} onToggle={toggle} onOpen={onOpen} />
        </TreeRow>
      </ul>
    </nav>
  );
}

function TreeChildren({
  drive,
  parent,
  current,
  expanded,
  onToggle,
  onOpen,
}: {
  drive: Drive;
  parent: string;
  current: string;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const list = useDriveFolder(drive.driveId, parent);
  if (list.isLoading) {
    return (
      <li className="space-y-1 py-1 pl-6">
        <Skeleton className="h-5 w-3/4 rounded-sm" />
      </li>
    );
  }
  const folders = (list.data?.entries ?? [])
    .filter((e) => e.type === 'dir' && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length === 0) {
    return <li className="text-muted-foreground py-1 pl-6 text-xs">{t('treeEmpty')}</li>;
  }
  return (
    <>
      {folders.map((e) => {
        const mine = e.path === drive.personalFolder;
        const channel = e.name.startsWith('#');
        return (
          <TreeRow
            key={e.path}
            path={e.path}
            name={mine ? t('treeYou', { name: e.name }) : channel ? e.name.slice(1) : e.name}
            icon={mine ? Home : channel ? HashIcon : FolderSimpleIcon}
            current={current}
            expanded={expanded}
            onToggle={onToggle}
            onOpen={onOpen}
          >
            <TreeChildren drive={drive} parent={e.path} current={current} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
          </TreeRow>
        );
      })}
    </>
  );
}

function TreeRow({
  path,
  name,
  icon: Glyph,
  current,
  expanded,
  onToggle,
  onOpen,
  children,
}: {
  path: string;
  name: string;
  icon: ComponentType<{ className?: string }>;
  current: string;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations('drives');
  const open = expanded.has(path);
  const active = current === path;
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={active}>
      <div
        className={cn(
          'duration-fast flex h-7 min-w-0 items-center rounded-md transition-colors',
          active ? 'bg-accent text-foreground font-medium' : 'text-foreground hover:bg-accent/60',
        )}
      >
        <button
          type="button"
          aria-label={open ? t('treeCollapse', { name }) : t('treeExpand', { name })}
          onClick={() => onToggle(path)}
          className="text-muted-foreground flex size-6 shrink-0 items-center justify-center"
        >
          <CaretRightIcon className={cn('duration-fast size-3 transition-transform', open && 'rotate-90')} />
        </button>
        <button
          type="button"
          onClick={() => {
            onOpen(path);
            if (!open) onToggle(path);
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left text-sm"
          title={name}
        >
          <Glyph className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      </div>
      {open ? (
        <ul role="group" className="space-y-0.5 pl-3">
          {children}
        </ul>
      ) : null}
    </li>
  );
}
