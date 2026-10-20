'use client';

import { Button } from '@/components/ui/button';
import { warningToast } from '@/components/ui/toast';
import { Home } from '@/features/icon/icons/home';
import { useSessionDrives } from '@/hooks/drives/use-drives';
import type { SessionDrive } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';
import { ArrowUpRightIcon, FolderIcon, WarningIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

/** Where the person's own folder also appears in the box: a path, not prose. */
const DESKTOP_PATH = '~/Desktop';

/**
 * The Files row of the session's ⚙ sheet: the folders of the project's Drive
 * this session mounts, where the agent sees them, and whether it may write.
 * What mounts follows folder access: share a folder in Drive to give it to
 * this session (it arrives within seconds), stop sharing to take it away. The
 * person's own folder is their desktop, at /drives/me.
 */
export function SessionDrivesList({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const t = useTranslations('drives');
  const session = useSessionDrives(projectId, sessionId);
  const rows = session.data?.drives ?? [];
  const skipped = session.data?.skipped ?? [];

  return (
    <div className="flex flex-col gap-3">
      <Button
        asChild
        variant="ghost"
        size="xs"
        className="text-muted-foreground hover:text-foreground -ml-1.5 gap-1 self-start"
      >
        <Link href={`/projects/${projectId}/drive`}>
          {t('openDrive')}
          <ArrowUpRightIcon className="size-3.5" />
        </Link>
      </Button>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">
          {session.isLoading ? t('sessionCanUse') : t('sessionNoFolders')}
        </p>
      ) : (
        // Up to 8 mount (the sandbox's volume limit), so the list stays short.
        <ul className="border-border divide-border divide-y rounded-lg border">
          {rows.map((row) => (
            <li key={row.mountPath}>
              <SessionFolderRow projectId={projectId} row={row} />
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 ? (
        <p
          role="status"
          className="bg-kortix-orange/15 text-foreground flex items-start gap-2 rounded-md px-2.5 py-2 text-xs text-pretty"
        >
          <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" weight="fill" />
          {t('sessionSkippedDrives', { count: skipped.length, names: skipped.map((d) => d.name).join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Raises the session's conflict notice: one toast when a mounted folder gets a
 * new conflict copy. Mounted beside the composer, with no chrome of its own.
 */
export function SessionDrivesWatch({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSessionDrives(projectId, sessionId);
  const conflicts = (session.data?.drives ?? []).reduce((sum, row) => sum + (row.openConflicts ?? 0), 0);
  useConflictToast(conflicts, sessionId);
  return null;
}

/** One mounted folder: its name, where the agent sees it, and read or write. It opens the folder in Drive. */
function SessionFolderRow({ projectId, row }: { projectId: string; row: SessionDrive }) {
  const t = useTranslations('drives');
  const mine = row.role === 'me';
  const path = mine ? '~' : (row.subdir || '/').replace(/^\/+/, '');
  const Glyph = mine ? Home : FolderIcon;
  return (
    <Link
      href={`/projects/${projectId}/drive${path ? `?path=${encodeURI(path)}` : ''}`}
      className="hover:bg-accent/60 flex min-w-0 items-center gap-2.5 px-3 py-2 outline-none focus-visible:bg-accent"
    >
      <Glyph className="text-muted-foreground size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{mine ? t('myDrive') : row.name}</span>
        <span className="text-muted-foreground truncate font-mono text-xs">
          {mine ? `${row.mountPath} · ${DESKTOP_PATH}` : row.mountPath}
        </span>
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">{row.readOnly ? t('readOnly') : t('readWrite')}</span>
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
