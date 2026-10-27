'use client';

import { HardDrivesIcon } from '@phosphor-icons/react';
import type { DriveEntry } from '@kortix/sdk';

import {
  useDriveFolder,
  useFolderAccess,
  useProjectDrive,
  useShareFolder,
  useUnshareFolder,
} from '../../files/drives/use-drives';
import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { Switch } from '../../primitives/switch';
import { errorToast } from '../../primitives/toast';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { AccessLead } from './agent-access-list';

/**
 * Access > Drives: which shared drives an agent gets. Turning one on shares
 * that drive's folder with the agent, the same grant Drive > Share makes, so
 * it writes at once and does not wait for the page's Save.
 *
 * The view is often one or two rows, so it carries a second panel with real
 * content: "In a session", the folders a session of this agent sees and
 * where each one is mounted. The near-empty view then reads as intentional,
 * never as one card floating in space.
 *
 * ponytail: no per-drive file count or last-update column. The folder access
 * read carries neither; add them when the drive listing serves them.
 */
export function AgentDrivesSection({
  projectId,
  agentName,
  repositoryAccess = true,
}: {
  projectId: string;
  agentName: string;
  /** Whether sessions of the agent get the project repository at /workspace. */
  repositoryAccess?: boolean;
}) {
  const t = useTranslations('drives');
  const tTabs = useTranslations('agentEditor.tabs');
  const drive = useProjectDrive(projectId);
  const root = useDriveFolder(drive.data?.driveId ?? null, '/');
  const drives = (root.data?.entries ?? []).filter((e) => e.type === 'dir' && !/^\/?Users(\/|$)/.test(e.path));
  const driveId = drive.data?.driveId ?? null;

  let list;
  if (drive.isLoading || root.isLoading) {
    list = (
      <EditorList>
        {[0, 1].map((i) => (
          <li key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
            <Skeleton className="h-4 w-40 rounded-sm" />
          </li>
        ))}
      </EditorList>
    );
  } else if (drive.isError || root.isError || !driveId) {
    list = (
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
    list = <EmptyState media={<EmptyArt icon={HardDrivesIcon} />} title={t('noCompanyDrives')} />;
  } else {
    list = (
      <EditorList>
        {drives.map((entry) => (
          <AgentDriveRow key={entry.path} driveId={driveId} entry={entry} agentName={agentName} />
        ))}
      </EditorList>
    );
  }

  return (
    <section className="space-y-6" data-testid="agent-access-drives">
      <AccessLead
        description={tTabs('drivesLead')}
        action={<ManageButton href={(id) => uiRoutes().drive(id)} />}
      />
      {list}
      <section className="space-y-3">
        <h3 className="text-foreground flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {tTabs('inSession')}
          <span className="text-muted-foreground text-xs font-normal">{tTabs('inSessionHint')}</span>
        </h3>
        <EditorList>
          {repositoryAccess ? <MountRow path="/workspace" label={tTabs('mountRepository')} /> : null}
          {driveId
            ? drives.map((entry) => (
                <DriveMount key={entry.path} driveId={driveId} entry={entry} agentName={agentName} />
              ))
            : null}
        </EditorList>
      </section>
    </section>
  );
}

function normalPath(entry: DriveEntry) {
  return entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
}

/** The agent's state on one drive: its own grant, or one it inherits. */
function useDriveGrant(driveId: string, entry: DriveEntry, agentName: string) {
  const path = normalPath(entry);
  const access = useFolderAccess(driveId, path);
  const grants = access.data?.grants ?? [];
  const own = grants.find((g) => !g.inherited && g.principalType === 'agent' && g.principalId === agentName);
  // Everyone in the project, or a grant on a folder above, already reaches the agent.
  const inherited =
    !own && grants.some((g) => g.principalType === 'project' || (g.principalType === 'agent' && g.principalId === agentName));
  return { path, access, own, inherited, on: !!own || inherited };
}

function AgentDriveRow({ driveId, entry, agentName }: { driveId: string; entry: DriveEntry; agentName: string }) {
  const t = useTranslations('drives');
  const tTabs = useTranslations('agentEditor.tabs');
  const { path, access, own, inherited, on } = useDriveGrant(driveId, entry, agentName);
  const share = useShareFolder();
  const unshare = useUnshareFolder();
  const canManage = access.data?.access === 'manage' && !!access.data?.grantable;
  const pending = share.isPending || unshare.isPending;

  const toggle = async (next: boolean) => {
    try {
      if (next) await share.mutateAsync({ driveId, path, principalType: 'agent', principalId: agentName, level: 'write' });
      else if (own) await unshare.mutateAsync({ driveId, grantId: own.grantId });
    } catch {
      errorToast(t('shareFailed'));
    }
  };

  const who = inherited ? t('everyoneInProject') : on ? tTabs('thisAgent') : tTabs('notShared');
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{entry.name}</span>
        <span className="text-muted-foreground block truncate text-xs">{who}</span>
      </span>
      {access.isLoading ? (
        <Skeleton className="h-5 w-9 rounded-full" />
      ) : (
        <Switch
          checked={on}
          disabled={!canManage || inherited || pending}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={t('levelFor', { name: entry.name })}
        />
      )}
    </li>
  );
}

function DriveMount({ driveId, entry, agentName }: { driveId: string; entry: DriveEntry; agentName: string }) {
  const { path, on } = useDriveGrant(driveId, entry, agentName);
  if (!on) return null;
  return <MountRow path={`/drives${path}`} label={entry.name} />;
}

function MountRow({ path, label }: { path: string; label: string }) {
  return (
    <li className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
      <span className="text-muted-foreground min-w-0 truncate text-sm">{label}</span>
      <span className="text-muted-foreground shrink-0 font-mono text-xs">{path}</span>
    </li>
  );
}
