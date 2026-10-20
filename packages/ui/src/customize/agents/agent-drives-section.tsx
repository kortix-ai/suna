'use client';

import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { EditorSection } from '../sections/view/agent-editor-primitives';
import { Button } from '../../primitives/button';
import { Skeleton } from '../../primitives/skeleton';
import { Switch } from '../../primitives/switch';
import { errorToast } from '../../primitives/toast';
import {
  useDriveFolder,
  useFolderAccess,
  useProjectDrive,
  useShareFolder,
  useUnshareFolder,
} from '../../files/drives/use-drives';
import { useTranslations } from '../../i18n';
import type { DriveEntry } from '@kortix/sdk';
import { HardDriveIcon } from '@phosphor-icons/react';
import { UiLink as Link } from '../../providers/ui-provider';

/**
 * Which shared drives an agent gets, on the agent's page, beside Apps and
 * Secrets. Turning one on shares that drive's folder with the agent: every
 * session of the agent then mounts it under /drives. It writes the folder's
 * access at once, the same grant Drive → Share makes, so it does not wait for
 * the page's Save.
 */
export function AgentDrivesSection({ projectId, agentName }: { projectId: string; agentName: string }) {
  const t = useTranslations('drives');
  const drive = useProjectDrive(projectId);
  const root = useDriveFolder(drive.data?.driveId ?? null, '/');
  const drives = (root.data?.entries ?? []).filter(
    (e) => e.type === 'dir' && !/^\/?Users(\/|$)/.test(e.path),
  );

  let body;
  if (drive.isLoading || root.isLoading) {
    body = (
      <div className="space-y-2">
        <Skeleton className="h-13 w-full rounded-md" />
        <Skeleton className="h-13 w-full rounded-md" />
      </div>
    );
  } else if (drive.isError || root.isError || !drive.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void root.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (drives.length === 0) {
    body = <EmptyState size="sm" title={t('noCompanyDrives')} />;
  } else {
    body = (
      <ul className="space-y-2">
        {drives.map((entry) => (
          <AgentDriveRow key={entry.path} driveId={drive.data!.driveId} entry={entry} agentName={agentName} />
        ))}
      </ul>
    );
  }

  return (
    <EditorSection
      title={t('customizeTitle')}
      description={t('accessAgentsCompanyHint')}
      trailing={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/projects/${projectId}/drive`}>{t('driveLabel')}</Link>
        </Button>
      }
    >
      <div className="py-4">{body}</div>
    </EditorSection>
  );
}

function AgentDriveRow({ driveId, entry, agentName }: { driveId: string; entry: DriveEntry; agentName: string }) {
  const t = useTranslations('drives');
  const path = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
  const access = useFolderAccess(driveId, path);
  const share = useShareFolder();
  const unshare = useUnshareFolder();
  const grants = access.data?.grants ?? [];
  const own = grants.find((g) => !g.inherited && g.principalType === 'agent' && g.principalId === agentName);
  // Everyone in the project, or a grant on a folder above, already reaches the agent.
  const inherited = !own && grants.some((g) => g.principalType === 'project' || (g.principalType === 'agent' && g.principalId === agentName));
  const canManage = access.data?.access === 'manage' && !!access.data?.grantable;
  const pending = share.isPending || unshare.isPending;

  const toggle = async (on: boolean) => {
    try {
      if (on) await share.mutateAsync({ driveId, path, principalType: 'agent', principalId: agentName, level: 'write' });
      else if (own) await unshare.mutateAsync({ driveId, grantId: own.grantId });
    } catch {
      errorToast(t('shareFailed'));
    }
  };

  return (
    <li className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2">
      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
        <HardDriveIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{entry.name}</p>
        <p className="text-muted-foreground truncate font-mono text-xs">
          {inherited ? t('everyoneInProject') : `/drives${path}`}
        </p>
      </div>
      {access.isLoading ? (
        <Skeleton className="h-5 w-9 rounded-full" />
      ) : (
        <Switch
          checked={!!own || inherited}
          disabled={!canManage || inherited || pending}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={t('levelFor', { name: entry.name })}
        />
      )}
    </li>
  );
}
