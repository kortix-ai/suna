'use client';

import { type Drive, makeDriveFolder } from '@kortix/sdk';
import { spaceDriveFolders } from '@kortix/shared';
import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import {
  DriveExplorer,
  type FileExplorerSource,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  useDriveAvailability,
  useDriveFolder,
  useProjectDrive,
} from '@kortix/ui/files';
import { capabilityTabHref } from '@kortix/ui/internal/lib/capability-tab-routes';
import { createFilesStore, useFilesStore } from '@kortix/ui/internal/stores/files-store';
import { PROJECT_ACTIONS, type SpaceFolder, useProjectCan } from '@kortix/ui/workspace';
import { BrainIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

import { DriveFilesProvider, driveExplorerSource, toDrivePath } from './drive-explorer-source';
import { drivePathToParam, driveUrlWithPath } from './drive-path-param';

/**
 * A channel's or DM's Files or Memory tab: its Drive folder in the Drive
 * explorer (list, open, upload), the folder reading as the root. The folders
 * are `spaceDriveFolders` (@kortix/shared), the same ones the thread's agent
 * finds in /drives/README.md. Drive off: a "Turn on Drive" state and no
 * Drive request.
 */
export function SpaceFolderView({
  projectId,
  space,
  tab,
  place,
}: SpaceFolder & { projectId: string }) {
  const t = useTranslations('spaces');
  const availability = useDriveAvailability(projectId);
  const drive = useProjectDrive(projectId, availability.enabled);

  if (availability.isLoading) return null;
  if (!availability.enabled) return <DriveOff projectId={projectId} place={place} />;
  if (drive.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('folder.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void drive.refetch()}>
            {t('view.retry')}
          </Button>
        }
      />
    );
  }
  if (!drive.data) return null;
  const name = space.kind === 'channel' ? space.slug : space.dm_agent_name;
  const folders = name ? spaceDriveFolders(space.kind, name, drive.data.personalFolder, space.visibility === 'private' ? space.space_id : null) : null;
  if (!folders) return <SpaceFolderEmpty tab={tab} place={place} />;
  const note =
    tab === 'memory'
      ? space.kind === 'channel'
        ? t('folder.memoryNoteChannel', { place })
        : t('folder.memoryNoteDm', { agent: place })
      : null;
  return (
    <SpaceDriveFolder
      key={folders[tab]}
      projectId={projectId}
      drive={drive.data}
      path={folders[tab]}
      label={tab === 'memory' ? t('folder.memory') : place}
      tab={tab}
      place={place}
      note={note}
      // The Memory tab shows the channel's Memory folder; Files does not list it again.
      hidden={tab === 'files' ? folders.memory : null}
    />
  );
}

/**
 * One folder in the explorer. A folder not made yet (a DM's, or a channel's
 * from before folders were made on create) is made on first open; when the
 * caller may not make it, the tab shows its empty state.
 */
function SpaceDriveFolder({
  projectId,
  drive,
  path,
  label,
  tab,
  place,
  note,
  hidden,
}: {
  projectId: string;
  drive: Drive;
  path: string;
  label: string;
  tab: SpaceFolder['tab'];
  place: string;
  note: string | null;
  hidden: string | null;
}) {
  const t = useTranslations('spaces');
  const { user } = useAuth();
  const folder = useDriveFolder(drive.driveId, path);
  const missing = (folder.error as { status?: number } | null)?.status === 404;
  const make = useMutation({
    mutationFn: () => makeDriveFolder(drive.driveId, path),
    onSuccess: () => folder.refetch(),
    retry: false,
    // A refusal is not an error to show: the empty state below says it.
    onError: () => undefined,
  });
  const { mutate: makeFolder, isIdle: notMade } = make;
  useEffect(() => {
    if (missing && notMade) makeFolder();
  }, [missing, notMade, makeFolder]);

  const store = useMemo(() => {
    const s = createFilesStore();
    s.setState({ currentPath: path.replace(/^\/+/, ''), rootPath: '/', expandedDirs: new Set() });
    return s;
  }, [path]);

  // Refused, or made but still not listed (storage lag): the empty state.
  if (missing && (make.isError || (make.isSuccess && !folder.isFetching))) {
    return <SpaceFolderEmpty tab={tab} place={place} />;
  }
  if (folder.isError && !missing) {
    return (
      <ErrorState
        size="sm"
        title={t('folder.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void folder.refetch()}>
            {t('view.retry')}
          </Button>
        }
      />
    );
  }
  // Loading, or making the folder: nothing (navigation shows no skeleton).
  if (!folder.isSuccess) return null;
  const Glyph = tab === 'memory' ? BrainIcon : FolderSimpleIcon;
  return (
    <DriveFilesProvider driveId={drive.driveId} userId={user?.id}>
      <FilesStoreProvider store={store}>
        <SpaceExplorer
          projectId={projectId}
          drive={drive}
          path={path}
          label={label}
          icon={<Glyph />}
          note={note}
          hidden={hidden}
        />
      </FilesStoreProvider>
    </DriveFilesProvider>
  );
}

function SpaceExplorer({
  projectId,
  drive,
  path,
  label,
  icon,
  note,
  hidden,
}: {
  projectId: string;
  drive: Drive;
  path: string;
  label: string;
  icon: ReactNode;
  note: string | null;
  /** A drive path left out of every listing (the channel's Memory folder in Files). */
  hidden: string | null;
}) {
  const router = useRouter();
  const currentPath = toDrivePath(useFilesStore((s) => s.currentPath));
  // Upload, new folder, rename and delete where the caller may write the
  // folder in view (a subfolder can be narrower than the tab's folder).
  const access = useDriveFolder(drive.driveId, currentPath).data?.access ?? 'none';
  const canWrite = access === 'write' || access === 'manage';
  const source = useMemo<FileExplorerSource>(
    () => ({
      ...driveExplorerSource,
      capabilities: { ...driveExplorerSource.capabilities, write: canWrite },
      useFileList: (dirPath) => {
        const list = driveExplorerSource.useFileList(dirPath);
        // A local, so the memo below re-filters when the source swaps in a new `hidden`.
        const hide = hidden;
        const data = useMemo(
          () => list.data?.filter((n) => !(n.type === 'directory' && n.absolute === hide)),
          [list.data, hide],
        );
        return { ...list, data };
      },
    }),
    [canWrite, hidden],
  );
  // Where a new file or folder lands: the tab's folder, then the folders below it.
  const location = {
    icon,
    crumbs: [label, ...currentPath.slice(path.length).split('/').filter(Boolean)],
  };
  return (
    <FileExplorerSourceProvider value={source}>
      <DriveExplorer
        leading={
          note ? (
            <p className="text-muted-foreground min-w-0 truncate text-xs" title={note}>
              {note}
            </p>
          ) : undefined
        }
        rootLabel={label}
        rootIcon={icon}
        location={location}
        pathBase={{ path, label, icon }}
        onOpenFolder={(p) =>
          router.push(
            driveUrlWithPath(
              `${window.location.origin}/projects/${projectId}/drive`,
              drivePathToParam(p, drive.personalFolder),
            ),
          )
        }
      />
    </FileExplorerSourceProvider>
  );
}

function SpaceFolderEmpty({ tab, place }: { tab: SpaceFolder['tab']; place: string }) {
  const t = useTranslations('spaces');
  return (
    <EmptyState
      className="min-h-full"
      media={<EmptyArt />}
      title={t(`view.empty.${tab}.title`)}
      description={t(`view.empty.${tab}.description`, { place })}
    />
  );
}

/** Drive is off for the project: say so, and send whoever may turn it on to the switch. */
function DriveOff({ projectId, place }: { projectId: string; place: string }) {
  const t = useTranslations('spaces');
  const settings = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
  const canTurnOn = !settings.isLoading && settings.allowed === true;
  return (
    <div className="px-5 py-16">
      <EmptyState
        size="sm"
        title={t('folder.off.title')}
        description={t(canTurnOn ? 'folder.off.description' : 'folder.off.descriptionMember', {
          place,
        })}
        action={
          canTurnOn ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`${capabilityTabHref(projectId, 'config')}?section=feature-flags`}>
                {t('folder.off.action')}
              </Link>
            </Button>
          ) : null
        }
      />
    </div>
  );
}
