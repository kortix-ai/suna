'use client';

import type { Drive } from '@kortix/sdk';
import { useDriveFolder } from '@kortix/ui/files';
import { Home } from '@kortix/ui/internal/icons/home';
import { Skeleton } from '@kortix/ui/skeleton';
import { cn } from '@kortix/ui';
import { CaretRightIcon, FolderSimpleIcon, HardDriveIcon, HashIcon, RobotIcon, UsersIcon } from '@phosphor-icons/react';
import { type ComponentType, type ReactNode, useCallback, useEffect, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

const AGENTS = '/Agents';
const USERS = '/Users';

type Glyph = ComponentType<{ className?: string }>;

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** `/a/b/c` → `['/a', '/a/b', '/a/b/c']`. */
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

/**
 * Beside the folder in view: My files, then the Drive of each agent the
 * caller may use. Only an admin (`manage` at the top) also gets the whole
 * Drive as one tree under the project, every folder as it is stored. A
 * folder lists its subfolders when it is expanded; the folders on the way to
 * the one in view are expanded by themselves, and a folder with no subfolders
 * has no caret.
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
  const [leaves, setLeaves] = useState<ReadonlySet<string>>(() => new Set());
  // Moving to a folder (from the grid, a link, the breadcrumb) opens its way here too.
  useEffect(() => {
    setExpanded((prev) => {
      const way = ['/', ...ancestors(path).slice(0, -1)];
      if (way.every((p) => prev.has(p))) return prev;
      return new Set([...prev, ...way]);
    });
  }, [path]);
  const toggle = useCallback(
    (p: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      }),
    [],
  );
  const markLeaf = useCallback(
    (p: string, leaf: boolean) =>
      setLeaves((prev) => {
        if (prev.has(p) === leaf) return prev;
        const next = new Set(prev);
        if (leaf) next.add(p);
        else next.delete(p);
        return next;
      }),
    [],
  );
  const personal = drive.personalFolder;
  const agents = drive.agentDrives ?? [];
  const admin = drive.access === 'manage';
  const tree = { drive, current: path, expanded, leaves, onToggle: toggle, onLeaf: markLeaf, onOpen };

  return (
    <nav aria-label={t('folderTree')} className="border-border hidden w-64 shrink-0 space-y-4 overflow-y-auto border-r p-2 md:block">
      <ul className="space-y-0.5">
        {personal ? (
          <PlaceRow icon={Home} label={t('myDrive')} active={within(path, personal)} onClick={() => onOpen(personal)} />
        ) : null}
      </ul>
      {agents.length > 0 ? (
        <section className="space-y-1">
          <p className="text-muted-foreground px-2 text-xs">{t('agentsSection')}</p>
          <ul className="space-y-0.5">
            {agents.map((a) => (
              <PlaceRow key={a.path} icon={RobotIcon} label={a.agentName} active={within(path, a.path)} onClick={() => onOpen(a.path)} />
            ))}
          </ul>
        </section>
      ) : null}
      {admin ? (
        <section className="space-y-1">
          <p className="text-muted-foreground px-2 text-xs">{t('allFiles')}</p>
          <ul role="tree" aria-label={t('allFiles')} className="space-y-0.5">
            <TreeRow {...tree} path="/" name={rootLabel} icon={HardDriveIcon}>
              <TreeChildren {...tree} parent="/" />
            </TreeRow>
          </ul>
        </section>
      ) : null}
    </nav>
  );
}

/** A place people go first: one click, no caret. */
function PlaceRow({ icon: Icon, label, active, onClick }: { icon: Glyph; label: string; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'duration-fast flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
          active ? 'bg-accent text-foreground font-medium' : 'text-foreground hover:bg-accent/60',
        )}
      >
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

interface TreeProps {
  drive: Drive;
  current: string;
  expanded: ReadonlySet<string>;
  leaves: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onLeaf: (path: string, leaf: boolean) => void;
  onOpen: (path: string) => void;
}

function TreeChildren({ parent, ...tree }: TreeProps & { parent: string }) {
  const t = useTranslations('drives');
  const { drive, onLeaf } = tree;
  const list = useDriveFolder(drive.driveId, parent);
  const folders = (list.data?.entries ?? [])
    .filter((e) => e.type === 'dir' && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const loaded = !!list.data;
  // A folder with no subfolders drops its caret instead of opening onto nothing.
  useEffect(() => {
    if (loaded) onLeaf(parent, folders.length === 0);
  }, [loaded, folders.length, parent, onLeaf]);
  if (list.isLoading) {
    return (
      <li className="py-1 pl-6">
        <Skeleton className="h-5 w-3/4 rounded-sm" />
      </li>
    );
  }
  return (
    <>
      {folders.map((e) => {
        const mine = e.path === drive.personalFolder;
        const channel = e.name.startsWith('#');
        const icon: Glyph = mine ? Home : e.path === AGENTS || e.path.startsWith(`${AGENTS}/`) && e.path.split('/').length === 3 ? RobotIcon : e.path === USERS ? UsersIcon : channel ? HashIcon : FolderSimpleIcon;
        return (
          <TreeRow key={e.path} {...tree} path={e.path} name={mine ? t('treeYou', { name: e.name }) : channel ? e.name.slice(1) : e.name} icon={icon}>
            <TreeChildren {...tree} parent={e.path} />
          </TreeRow>
        );
      })}
    </>
  );
}

function TreeRow({
  path,
  name,
  icon: Icon,
  current,
  expanded,
  leaves,
  onToggle,
  onOpen,
  children,
}: TreeProps & { path: string; name: string; icon: Glyph; children: ReactNode }) {
  const t = useTranslations('drives');
  const leaf = leaves.has(path);
  const open = expanded.has(path) && !leaf;
  const active = current === path;
  return (
    <li role="treeitem" aria-expanded={leaf ? undefined : open} aria-selected={active}>
      <div
        className={cn(
          'duration-fast flex h-7 min-w-0 items-center rounded-md transition-colors',
          active ? 'bg-accent text-foreground font-medium' : 'text-foreground hover:bg-accent/60',
        )}
      >
        {leaf ? (
          <span aria-hidden className="size-6 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={open ? t('treeCollapse', { name }) : t('treeExpand', { name })}
            onClick={() => onToggle(path)}
            className="text-muted-foreground flex size-6 shrink-0 items-center justify-center"
          >
            <CaretRightIcon className={cn('duration-fast size-3 transition-transform', open && 'rotate-90')} />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            onOpen(path);
            if (!expanded.has(path)) onToggle(path);
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left text-sm"
          title={name}
        >
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      </div>
      {/* Mounted while expanded, also for a folder still loading: its listing decides the caret. */}
      {expanded.has(path) ? (
        <ul role="group" className={cn('space-y-0.5 pl-3', leaf && 'hidden')}>
          {children}
        </ul>
      ) : null}
    </li>
  );
}
