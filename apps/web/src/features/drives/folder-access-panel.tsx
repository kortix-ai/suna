'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { EditorSection } from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import { useFolderAccess } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import { LockIcon, ShareNetworkIcon } from '@phosphor-icons/react';
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
  onManage,
}: {
  driveId: string;
  path: string;
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
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onManage}>
          <ShareNetworkIcon className="size-3.5 shrink-0" />
          {canManage ? t('manageFolderAccess') : t('viewFolderAccess')}
        </Button>
      </div>
    );
  }

  return (
    <EditorSection
      title={atRoot ? t('whoCanAccess') : t('whoCanAccessFolder', { name: folderName(path, t('files')) })}
      description={atRoot ? undefined : t('accessPanelDescription')}
    >
      {body}
    </EditorSection>
  );
}
