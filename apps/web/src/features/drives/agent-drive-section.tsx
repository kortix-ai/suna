'use client';

import { Switch } from '@/components/ui/switch';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { useDriveGrants, useDrives, useSetDriveSubjectGrant } from '@/hooks/drives/use-drives';
import { useFormatter, useLocale, useNow, useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { DriveConflictsBanner } from './drive-conflicts-banner';
import { DriveFileBrowser } from './drive-file-browser';
import { canWriteDrive, formatBytes } from './drive-model';
import { DriveVersions } from './drive-versions';

/**
 * Agent page → Drive: the agent's own drive (its memory and outputs, mounted
 * at /drives/agent in every session of the agent), with its size, files,
 * history and restore. Also the viewer's opt-in to let this agent write all of
 * their own drive in their sessions.
 */
export function AgentDriveSection({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string;
}) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const drives = useDrives(projectId);
  const drive =
    (drives.data ?? []).find((d) => d.kind === 'agent' && d.agentName === agentName) ?? null;
  const [tab, setTab] = useState<'files' | 'versions'>('files');
  const [path, setPath] = useState('/');

  const meta = drive
    ? [
        t('mountedAt', { path: drive.mountPath ?? '/drives/agent' }),
        typeof drive.fileCount === 'number' ? t('fileCount', { count: drive.fileCount }) : null,
        typeof drive.sizeBytes === 'number'
          ? typeof drive.sizeLimitBytes === 'number' && drive.sizeLimitBytes > 0
            ? t('sizeOfLimit', {
                size: formatBytes(drive.sizeBytes, locale),
                limit: formatBytes(drive.sizeLimitBytes, locale),
              })
            : formatBytes(drive.sizeBytes, locale)
          : null,
        drive.lastChangeAt
          ? t('updatedAgo', { time: format.relativeTime(new Date(drive.lastChangeAt), now) })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className="space-y-4">
      <section className="bg-popover overflow-hidden rounded-md border">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t('agentDriveTitle')}</p>
          <p className="text-muted-foreground text-xs text-pretty">{t('agentDriveDescription')}</p>
        </div>
        {!drive ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">{t('noAgentDrives')}</p>
        ) : (
          <div className="flex h-[28rem] min-h-0 flex-col">
            {tab === 'files' ? (
              <DriveFileBrowser
                driveId={drive.driveId}
                driveName={drive.name}
                path={path}
                onNavigate={setPath}
                meta={meta}
                readOnly={!canWriteDrive(drive)}
                banner={
                  <DriveConflictsBanner
                    driveId={drive.driveId}
                    canWrite={canWriteDrive(drive)}
                    onOpenFolder={setPath}
                  />
                }
                controls={<AgentDriveTabs value={tab} onChange={setTab} />}
              />
            ) : (
              <>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
                  <p className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{drive.name}</p>
                  <AgentDriveTabs value={tab} onChange={setTab} />
                </div>
                <DriveVersions driveId={drive.driveId} />
              </>
            )}
          </div>
        )}
      </section>
      <PersonalFullWriteRow projectId={projectId} agentName={agentName} />
    </div>
  );
}

function AgentDriveTabs({
  value,
  onChange,
}: {
  value: 'files' | 'versions';
  onChange: (v: 'files' | 'versions') => void;
}) {
  const t = useTranslations('drives');
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as 'files' | 'versions')}>
      <TabsListCompact>
        <TabsTriggerCompact value="files">{t('files')}</TabsTriggerCompact>
        <TabsTriggerCompact value="versions">{t('versions')}</TabsTriggerCompact>
      </TabsListCompact>
    </Tabs>
  );
}

/** Your own drive: let this agent write all of it in your sessions (default: only its From agents folder). */
function PersonalFullWriteRow({ projectId, agentName }: { projectId: string; agentName: string }) {
  const t = useTranslations('drives');
  const drives = useDrives(projectId);
  const mine =
    (drives.data ?? []).find((d) => d.kind === 'personal' && d.isDefault && !d.shared) ?? null;
  const grants = useDriveGrants(mine?.driveId ?? null, !!mine);
  const setGrant = useSetDriveSubjectGrant();
  if (!mine) return null;
  const on = (grants.data ?? []).some(
    (g) => g.type === 'agent' && g.projectId === projectId && g.agentName === agentName,
  );

  return (
    <section className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('agentFullWriteTitle')}</p>
        <p className="text-muted-foreground text-xs text-pretty">
          {t('agentFullWriteDescription')}
        </p>
      </div>
      <Switch
        checked={on}
        disabled={grants.isLoading || setGrant.isPending}
        aria-label={t('agentFullWriteTitle')}
        onCheckedChange={(next) =>
          setGrant.mutate(
            {
              driveId: mine.driveId,
              subject: { type: 'agent', projectId, agentName },
              access: next ? 'write' : null,
            },
            { onError: () => errorToast(t('grantFailed')) },
          )
        }
      />
    </section>
  );
}
