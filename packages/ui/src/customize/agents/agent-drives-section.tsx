'use client';

import { ArrowUpRightIcon, FolderSimpleIcon } from '@phosphor-icons/react';
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
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { Switch } from '../../primitives/switch';
import { errorToast } from '../../primitives/toast';
import { UiLink as Link } from '../../providers/ui-provider';

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
  const driveHref = uiRoutes().drive(projectId);
  const root = useDriveFolder(drive.data?.driveId ?? null, '/');
  const drives = (root.data?.entries ?? []).filter((e) => e.type === 'dir' && !/^\/?Users(\/|$)/.test(e.path));
  const driveId = drive.data?.driveId ?? null;

  let list;
  if (drive.isLoading || root.isLoading) {
    list = (
      <ul className="divide-border divide-y rounded-md border">
        {[0, 1].map((i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-7 rounded-sm" />
            <Skeleton className="h-4 w-40 rounded-sm" />
          </li>
        ))}
      </ul>
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
    list = <EmptyState size="sm" title={t('noCompanyDrives')} />;
  } else {
    list = (
      <div className="overflow-hidden rounded-md border">
        <div className="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_14rem_4rem] gap-4 border-b px-4 py-2 text-xs md:grid">
          <span>{t('driveLabel')}</span>
          <span>{tTabs('whoSees')}</span>
          <span className="text-right">{tTabs('on')}</span>
        </div>
        <ul className="divide-border divide-y">
          {drives.map((entry) => (
            <AgentDriveRow key={entry.path} driveId={driveId} entry={entry} agentName={agentName} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm text-pretty">{tTabs('drivesLead')}</p>
          {driveHref ? (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={driveHref}>
                {tTabs('openDrive')}
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </Button>
          ) : null}
        </div>
        {list}
      </section>

      <section className="space-y-3">
        <h2 className="text-foreground flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {tTabs('inSession')}
          <span className="text-muted-foreground text-xs font-normal">{tTabs('inSessionHint')}</span>
        </h2>
        <ul className="divide-border divide-y rounded-md border">
          {repositoryAccess ? (
            <MountRow path="/workspace" label={tTabs('mountRepository')} />
          ) : null}
          {driveId
            ? drives.map((entry) => (
                <DriveMount key={entry.path} driveId={driveId} entry={entry} agentName={agentName} />
              ))
            : null}
        </ul>
      </section>
    </div>
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

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_14rem_4rem]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm">
          <FolderSimpleIcon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-medium">{entry.name}</p>
          <p className="text-muted-foreground truncate text-xs md:hidden">
            {inherited ? t('everyoneInProject') : on ? tTabs('thisAgent') : tTabs('notShared')}
          </p>
        </div>
      </div>
      <span className="text-muted-foreground hidden truncate text-sm md:block">
        {inherited ? t('everyoneInProject') : on ? tTabs('thisAgent') : tTabs('notShared')}
      </span>
      <div className="flex justify-end">
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
      </div>
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
    <li className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-foreground min-w-0 truncate text-sm">{label}</span>
      <span className="text-muted-foreground shrink-0 font-mono text-xs">{path}</span>
    </li>
  );
}
