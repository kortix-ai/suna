'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { warningToast } from '@/components/ui/toast';
import { useSessionDrives } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { cn } from '@/lib/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FolderIcon, HouseIcon, WarningIcon } from '@phosphor-icons/react';
import Link from 'next/link';
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
  const t = useTranslations('drives');
  const flag = useFeatureFlag(projectId, 'drives');
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
      <PopoverContent side="top" align="end" sideOffset={8} className="w-96 p-0">
        <div className="space-y-0.5 border-b px-4 py-3">
          <p className="text-sm font-medium">{t('sessionChipTitle')}</p>
          <p className="text-muted-foreground text-xs text-pretty">{t('sessionChipDescription')}</p>
        </div>
        {skipped.length > 0 ? (
          <p role="status" className="text-kortix-orange border-b px-4 py-2.5 text-xs text-pretty">
            {t('sessionSkippedDrives', { count: skipped.length, names: skipped.map((d) => d.name).join(', ') })}
          </p>
        ) : null}
        <ul className="max-h-72 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <li className="text-muted-foreground px-4 py-2 text-xs">{t('sessionNoFolders')}</li>
          ) : (
            rows.map((row) => (
              <li key={row.mountPath} className="flex min-w-0 items-center gap-2 px-4 py-1.5">
                {row.role === 'me' ? (
                  <HouseIcon className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{row.role === 'me' ? t('sessionDesktop') : row.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {row.role === 'me' ? [row.mountPath, DESKTOP_PATH].join(' · ') : row.mountPath}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {row.readOnly ? t('readOnly') : t('level.write')}
                </span>
              </li>
            ))
          )}
        </ul>
        <div className="border-t px-1.5 py-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full justify-start">
            <Link href={capabilityTabHref(projectId, 'files')}>{t('openDrive')}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
