'use client';

import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { warningToast } from '../../primitives/toast';
import { Home } from '../../internal/icons/home';
import { FolderPages } from '../project/components/drive-folder-thumbnail';
import { useDriveFolder, useSessionDrives } from './use-drives';
import type { SessionDrive } from '@kortix/sdk';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { ArrowUpRightIcon, FolderIcon, WarningIcon } from '@phosphor-icons/react';
import { useUiLink } from '../../providers/ui-provider';
import { useEffect, useRef } from 'react';

/** Where the person's own folder also appears in the box: a path, not prose. */
const DESKTOP_PATH = '~/Desktop';

/**
 * Composer chip: the folders of the project's Files this session mounts, and
 * where the agent sees them. What mounts follows folder access: share a folder
 * in Files to give it to this session (it arrives within seconds), stop sharing
 * to take it away. The person's own folder is their desktop, at /drives/me.
 *
 * Also the session's conflict notice: a folder with a new conflict copy turns
 * the chip orange and raises one toast.
 */
export function SessionDrivesChip({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const Link = useUiLink();
  const t = useTranslations('drives');
  const flag = useFeatureFlag(projectId, 'drives');
  const driveHref = uiRoutes().drive(projectId);
  const session = useSessionDrives(projectId, sessionId);
  const rows = session.data?.drives ?? [];
  const conflicts = rows.reduce((sum, row) => sum + (row.openConflicts ?? 0), 0);
  const skipped = session.data?.skipped ?? [];
  useConflictToast(conflicts, sessionId);

  if (!flag.enabled) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('sessionChipTitle')}
          className={cn(
            'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground gap-1.5 px-2',
            (conflicts > 0 || skipped.length > 0) && 'text-kortix-orange hover:text-kortix-orange',
          )}
        >
          {conflicts > 0 || skipped.length > 0 ? (
            <WarningIcon className="size-4 shrink-0" weight="fill" />
          ) : (
            <FolderIcon className="size-4 shrink-0" />
          )}
          <span className="tabular-nums">{t('sessionChipLabel', { count: rows.length })}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        // Tiles are Drive's folder card width (~160px): two across, or three.
        className={cn('p-3.5', rows.length > 2 ? 'w-[31rem]' : 'w-[22.5rem]')}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">{t('sessionCanUse')}</p>
          {driveHref ? (
            <Button
              asChild
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground -mr-1.5 gap-1"
            >
              <Link href={driveHref}>
                {t('openDrive')}
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-2 text-xs">{t('sessionNoFolders')}</p>
        ) : (
          // Tiles like Drive's folder cards: two across for one or two folders,
          // three for more. Up to 8 mount (the sandbox's volume limit), so the
          // grid tops out at three rows and scrolls past that.
          <ul className={cn('grid max-h-80 gap-x-2.5 gap-y-3 overflow-y-auto', rows.length > 2 ? 'grid-cols-3' : 'grid-cols-2')}>
            {rows.map((row) => (
              <li key={row.mountPath} className="min-w-0">
                <SessionFolderTile driveHref={driveHref} row={row} />
              </li>
            ))}
          </ul>
        )}
        {skipped.length > 0 ? (
          <p
            role="status"
            className="bg-kortix-orange/15 text-foreground mt-3 flex items-start gap-2 rounded-md px-2.5 py-2 text-xs text-pretty"
          >
            <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" weight="fill" />
            {t('sessionSkippedDrives', { count: skipped.length, names: skipped.map((d) => d.name).join(', ') })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One mounted folder: the two pages of Drive's folder card (\`FolderPages\`,
 * the folder's chalk colour, lines that follow its item count), without the
 * pocket or a count. It opens the folder in Drive. The person's own folder
 * wears the focus border and the home mark by its name: it is where the agent
 * saves what it makes for them.
 */
function SessionFolderTile({ driveHref, row }: { driveHref: string | null; row: SessionDrive }) {
  const Link = useUiLink();
  const t = useTranslations('drives');
  const mine = row.role === 'me';
  // The count lists the folder; the popover mounts only while open.
  const listing = useDriveFolder(row.driveId, row.subdir || '/');
  const count = listing.data?.entries.length ?? null;
  const path = mine ? '~' : (row.subdir || '/').replace(/^\/+/, '');
  const label = mine ? t('myDrive') : row.name;
  const title = mine ? `${row.mountPath} · ${DESKTOP_PATH}` : row.mountPath;
  const className = 'group flex min-w-0 flex-col gap-1.5 rounded-md outline-none';
  const body = (
    <>
      <span
        className={cn(
          'bg-card relative block h-[76px] overflow-hidden rounded-lg border transition-colors',
          mine ? 'border-ring' : 'group-hover:border-border border-transparent',
          'group-focus-visible:ring-ring/15 group-focus-visible:border-ring group-focus-visible:ring-2',
        )}
      >
        {/* The pages sit exactly as in Drive's folder card (drawn at its full
            120px), and the tile is the card's top 76px: a little past where
            its pocket starts (53%), cut flat by the tile's edge. No pocket, no
            count; the lines still show how full the folder is. */}
        <span aria-hidden className="absolute inset-x-0 top-0 block h-[120px]">
          <FolderPages name={row.name} count={count} pocket={false} />
        </span>
        {row.readOnly ? (
          <span className="bg-muted text-muted-foreground absolute right-2 bottom-2 rounded-sm px-1.5 py-0.5 text-xs leading-none">
            {t('readOnly')}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        {mine ? <Home className="text-muted-foreground size-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
    </>
  );
  // A host without a Drive page shows the tile without the link.
  if (!driveHref) {
    return (
      <div title={title} className={className}>
        {body}
      </div>
    );
  }
  return (
    <Link href={`${driveHref}${path ? `?path=${encodeURI(path)}` : ''}`} title={title} className={className}>
      {body}
    </Link>
  );
}

/** One toast per rise in the session's open conflicts, never on the first read. */
function useConflictToast(count: number, sessionId: string) {
  const t = useTranslations('drives');
  const seen = useRef<{ sessionId: string; count: number } | null>(null);
  useEffect(() => {
    const last = seen.current;
    seen.current = { sessionId, count };
    if (!last || last.sessionId !== sessionId) return;
    if (count > last.count) warningToast(t('conflictToast', { count: count - last.count }));
  }, [count, sessionId, t]);
}
