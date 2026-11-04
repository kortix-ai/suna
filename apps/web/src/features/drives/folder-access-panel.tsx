'use client';

import { Button } from '@kortix/ui/button';
import { Skeleton } from '@kortix/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { EditorSection } from '@kortix/ui/customize/sections/view/agent-editor-primitives';
import { useFolderAccess } from '@kortix/ui/files';
import { useDriveAdminReads } from '@kortix/sdk/react';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { LockIcon, ShareNetworkIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { AccessRow, GrantAvatar, folderName } from './folder-access-dialog';
import { folderAudience } from './folder-audience';

/**
 * The open folder's access, beside the explorer: who can open it, and the
 * button that changes it. The same section an agent's page shows for who can
 * use the agent, so a folder reads the way an agent does.
 */
export function FolderAccessPanel({
  driveId,
  path,
  name,
  onManage,
}: {
  driveId: string;
  path: string;
  /** The folder's name as the page shows it (a person's folder: their name). */
  name?: string;
  onManage: () => void;
}) {
  const t = useTranslations('drives');
  const { user } = useAuth();
  const atRoot = path === '/';
  const access = useFolderAccess(driveId, path, !atRoot);
  const audience = useMemo(() => folderAudience(access.data?.grants ?? []), [access.data]);
  const canManage = access.data?.access === 'manage' && !!access.data?.grantable;

  let body;
  if (atRoot) {
    body = <p className="text-muted-foreground py-3.5 text-xs text-pretty">{t('accessPanelRoot')}</p>;
  } else if (access.isLoading || !access.data) {
    body = (
      <div className="space-y-2 py-3.5">
        <Skeleton className="h-11 w-full rounded-md" />
        <Skeleton className="h-11 w-full rounded-md" />
      </div>
    );
  } else if (!access.data.grantable) {
    body = <p className="text-muted-foreground py-3.5 text-xs text-pretty">{t('notGrantable')}</p>;
  } else {
    const everyone = audience.everyoneGrant ?? audience.inheritedEveryone;
    const restricted = !everyone && audience.named.length === 0;
    body = (
      <div className="space-y-3 py-3.5">
        <ul className="space-y-2">
          {everyone ? (
            <AccessRow
              avatar={<GrantAvatar type="project" label={t('everyoneInProject')} />}
              label={t('everyoneInProject')}
              meta={everyone.inherited ? t('inheritedFrom', { path: everyone.path }) : t(`level.${everyone.level}`)}
            />
          ) : null}
          {audience.owner ? (
            <AccessRow
              avatar={<GrantAvatar type="user" label={audience.owner.label} />}
              label={audience.owner.principalId === user?.id ? t('you') : audience.owner.label}
              meta={t('ownFolder')}
            />
          ) : null}
          {audience.owner ? (
            <AccessRow
              avatar={<ShieldCheckIcon className="text-muted-foreground size-6 shrink-0 p-1" />}
              label={t('folderInfo.projectAdmins')}
              meta={t('folderInfo.adminsOpenRecorded')}
            />
          ) : restricted ? (
            <AccessRow
              avatar={<LockIcon className="text-muted-foreground size-6 shrink-0 p-1" />}
              label={t('audienceAdmins')}
              meta={t('audienceAdminsShort')}
            />
          ) : null}
          {audience.named.map((n) => (
            <AccessRow
              key={`${n.type}:${n.id}`}
              avatar={<GrantAvatar type={n.type} label={n.label} />}
              label={n.type === 'agent' ? t('agentLabel', { name: n.label }) : n.label}
              meta={t(`level.${n.level}`)}
            />
          ))}
          {audience.inherited
            .filter((g) => g.principalType !== 'project' && g !== audience.owner)
            .map((g) => (
              <AccessRow
                key={g.grantId}
                muted
                avatar={<GrantAvatar type={g.principalType} label={g.label} />}
                label={g.principalType === 'agent' ? t('agentLabel', { name: g.label }) : g.label}
                meta={t('inheritedFrom', { path: g.path })}
              />
            ))}
        </ul>
        {audience.owner ? <AdminOpens driveId={driveId} path={path} /> : null}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onManage}>
          <ShareNetworkIcon className="size-3.5 shrink-0" />
          {canManage ? t('manageFolderAccess') : t('viewFolderAccess')}
        </Button>
      </div>
    );
  }

  return (
    <EditorSection
      title={atRoot ? t('whoCanAccess') : t('whoCanAccessFolder', { name: name ?? folderName(path, t('files')) })}
      description={atRoot ? undefined : t('accessPanelDescription')}
    >
      {body}
    </EditorSection>
  );
}

/** A person's own folder: the project admins who opened it, newest first. */
export function AdminOpens({ driveId, path }: { driveId: string; path: string }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const reads = useDriveAdminReads(driveId, path);
  // Only the folder's owner and admins may read the list; anyone else gets nothing to show.
  if (!reads.data) return null;
  const rows = reads.data.reads;
  return (
    <div className="space-y-1.5">
      <p className="text-foreground text-xs font-medium">{t('folderInfo.openedByAdmins')}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('folderInfo.noAdminOpens')}</p>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 5).map((r) => (
            <li key={`${r.adminUserId}:${r.day}`} className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums">{relativeTime(r.lastAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
