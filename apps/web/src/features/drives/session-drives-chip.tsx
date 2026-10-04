'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useChangeSessionDrive, useDrives, useSessionDrives } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { HardDrivesIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { DRIVE_KIND_ICON } from './drive-icons';
import { type SessionDriveRow, foldSessionDrives } from './drive-model';

/**
 * Composer chip: the drives this session mounts, and changing them while it
 * runs. Attach any drive the viewer may use, take one out, switch one between
 * read-only and read-write, or let the agent write your whole drive (by
 * default it writes only the drive's From agents folder). A change reaches
 * the running sandbox within seconds and every later sandbox of the session.
 *
 * Also the session's conflict notice: a drive with a new conflict copy turns
 * the chip orange and raises one toast.
 */
export function SessionDrivesChip({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const t = useTranslations('drives');
  const flag = useFeatureFlag(projectId, 'drives');
  const session = useSessionDrives(projectId, sessionId);
  const rows = useMemo(() => foldSessionDrives(session.data?.drives ?? []), [session.data]);
  const conflicts = rows.reduce((sum, row) => sum + row.openConflicts, 0);
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
            <HardDrivesIcon className="size-4 shrink-0" />
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
            {t('sessionSkippedDrives', {
              count: skipped.length,
              names: skipped.map((drive) => drive.name).join(', '),
            })}
          </p>
        ) : null}
        <SessionDriveList
          projectId={projectId}
          sessionId={sessionId}
          rows={rows}
          personal={!!session.data?.personal}
        />
        <div className="border-t px-1.5 py-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full justify-start">
            <Link href={`/projects/${projectId}/drive`}>{t('openDrive')}</Link>
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

function SessionDriveList({
  projectId,
  sessionId,
  rows,
  personal,
}: {
  projectId: string;
  sessionId: string;
  rows: SessionDriveRow[];
  personal: boolean;
}) {
  const t = useTranslations('drives');
  const change = useChangeSessionDrive(projectId, sessionId);
  const drives = useDrives(projectId);
  const [pick, setPick] = useState('');

  const mounted = new Set(rows.map((row) => row.driveId));
  // Personal drives (yours, or shared with you) attach only to your own private session.
  const attachable = (drives.data ?? []).filter(
    (drive) => !mounted.has(drive.driveId) && (drive.kind !== 'personal' || personal),
  );

  const run = (input: Parameters<typeof change.mutate>[0], done: string) =>
    change.mutate(input, {
      onSuccess: (result) =>
        successToast(
          (result as { live?: boolean } | null | undefined)?.live === false ? t('appliesNextStart') : done,
        ),
      onError: (error) => errorToast((error as Error)?.message || t('sessionDriveFailed')),
    });

  return (
    <div className="max-h-80 overflow-y-auto">
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-3 text-xs">{t('sessionNoDrives')}</p>
      ) : (
        <ul className="p-1.5">
          {rows.map((row) => {
            const KindIcon = DRIVE_KIND_ICON[row.kind] ?? HardDrivesIcon;
            const own = row.role === 'me';
            return (
              <li key={row.driveId} className="space-y-1 rounded-md px-2 py-1.5">
                <div className="flex items-center gap-2.5">
                  <KindIcon className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {row.name}
                      {row.ownerEmail ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {row.ownerEmail.split('@')[0]}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {row.mountPath}
                    </p>
                  </div>
                  {own ? null : (
                    <Select
                      value={row.readOnly ? 'read' : 'write'}
                      disabled={change.isPending}
                      onValueChange={(access) =>
                        run(
                          {
                            type: 'access',
                            driveId: row.driveId,
                            access: access as 'read' | 'write',
                          },
                          t('sessionDriveUpdated'),
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={t('accessLabel')}
                        className="h-7 w-32 shrink-0 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value="write">{t('accessWrite')}</SelectItem>
                        <SelectItem value="read">{t('accessRead')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('detachDrive', { name: row.name })}
                    disabled={change.isPending}
                    onClick={() =>
                      run({ type: 'detach', driveId: row.driveId }, t('sessionDriveDetached'))
                    }
                  >
                    <XIcon className="size-4 shrink-0" />
                  </Button>
                </div>
                {own ? (
                  <div className="flex items-center gap-2 pl-6">
                    <p className="text-muted-foreground min-w-0 flex-1 text-xs text-pretty">
                      {row.readOnly && row.fromAgentsPath
                        ? t('fromAgentsHint', { path: row.fromAgentsPath })
                        : t('fullWriteOnHint')}
                    </p>
                    <Switch
                      checked={!row.readOnly}
                      disabled={change.isPending}
                      aria-label={t('fullWriteLabel')}
                      onCheckedChange={(on) =>
                        run(
                          { type: 'access', driveId: row.driveId, access: on ? 'write' : 'read' },
                          on ? t('fullWriteOn') : t('fullWriteOff'),
                        )
                      }
                    />
                  </div>
                ) : null}
                {row.openConflicts > 0 ? (
                  <p className="text-kortix-orange pl-6 text-xs">
                    {t('conflictCount', { count: row.openConflicts })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {attachable.length ? (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger aria-label={t('attachDrive')} className="h-8 min-w-0 flex-1 text-sm">
              <SelectValue placeholder={t('attachDrive')} />
            </SelectTrigger>
            <SelectContent>
              {attachable.map((drive) => (
                <SelectItem key={drive.driveId} value={drive.driveId}>
                  {drive.shared && drive.ownerEmail
                    ? `${drive.name} · ${drive.ownerEmail.split('@')[0]}`
                    : drive.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={!pick || change.isPending}
            onClick={() => {
              run({ type: 'attach', driveId: pick }, t('sessionDriveAttached'));
              setPick('');
            }}
          >
            {t('attach')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
