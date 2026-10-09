'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { createFilesStore, useFilesStore } from '@/features/file-browser/store/files-store';
import { ErrorState } from '@/features/layout/section/error-state';
import { DriveExplorer, FileExplorerSourceProvider, FilesStoreProvider } from '@/features/project-files';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useDriveAvailability, useDriveFolder, useProjectDrive } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import type { Drive } from '@kortix/sdk';
import { HouseIcon, ShareNetworkIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { DriveConflictsBanner } from './drive-conflicts-banner';
import { DriveFilesProvider, driveExplorerSource, parentDrivePath, toDrivePath } from './drive-explorer-source';
import { FolderAccessDialog } from './folder-access-dialog';

/**
 * /projects/[id]/drive — the project's Files: one folder tree everyone in the
 * project works in, in the same explorer as Repo. What each person sees and
 * may change follows folder access; their own folder (`Users/<name>`) is
 * private until they share it and is the desktop of their sessions.
 */
export function FilesView({ projectId }: { projectId: string }) {
  const t = useTranslations('drives');
  const availability = useDriveAvailability(projectId);
  const drive = useProjectDrive(projectId, availability.enabled);
  const router = useRouter();
  // Volumes off for the organization: there is no drive page; Files is the repo browser.
  const off = !availability.isLoading && !availability.enabled;
  useEffect(() => {
    if (off) router.replace(`/projects/${projectId}/files`);
  }, [off, projectId, router]);

  let body: ReactNode;
  if (availability.isLoading || (availability.enabled && drive.isLoading)) {
    body = (
      <div className="space-y-2 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (!availability.enabled) {
    body = null;
  } else if (drive.isError || !drive.data) {
    body = (
      <ErrorState
        title={t('loadError')}
        className="h-full"
        action={
          <Button variant="outline" size="sm" onClick={() => void drive.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else {
    body = <FilesBrowser drive={drive.data} />;
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-1 flex-col">
      <ProjectPageHeader title={t('files')} href={`/projects/${projectId}/drive`} />
      {body}
    </div>
  );
}

function FilesBrowser({ drive }: { drive: Drive }) {
  // The explorer's store starts at the top of Files, not at a sandbox path.
  const store = useMemo(() => {
    const s = createFilesStore();
    // Held to `/`, so "home" (the root crumb, an empty path) is the top of
    // Files and never the sandbox default `/workspace`, which Files has not.
    s.setState({ currentPath: '/', rootPath: '/', expandedDirs: new Set() });
    return s;
  }, []);
  return (
    <DriveFilesProvider driveId={drive.driveId}>
      <FilesStoreProvider store={store}>
        <FilesExplorer drive={drive} />
      </FilesStoreProvider>
    </DriveFilesProvider>
  );
}

function FilesExplorer({ drive }: { drive: Drive }) {
  const t = useTranslations('drives');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const path = toDrivePath(currentPath);
  const folder = useDriveFolder(drive.driveId, path);
  const access = folder.data?.access ?? 'none';
  const canWrite = access === 'write' || access === 'manage';
  const [sharing, setSharing] = useState(false);

  // A folder that is gone (deleted, moved, or never there) is not an error
  // page: step up to the nearest folder that lists.
  const missing = folder.isError && path !== '/' && (folder.error as { status?: number } | null)?.status === 404;
  useEffect(() => {
    if (!missing) return;
    navigateToPath(parentDrivePath(path).replace(/^\//, '') || '/');
  }, [missing, path, navigateToPath]);

  // Upload, new folder, rename and delete only where the caller may write;
  // the API refuses the rest anyway.
  const source = useMemo(
    () => ({ ...driveExplorerSource, capabilities: { ...driveExplorerSource.capabilities, write: canWrite } }),
    [canWrite],
  );

  const leading = (
    <div className="flex items-center gap-1">
      {drive.personalFolder ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigateToPath(drive.personalFolder!.replace(/^\//, ''))}
          title={t('myFolderHint')}
        >
          <HouseIcon className="size-4" />
          <span className="hidden sm:inline">{t('myFolder')}</span>
        </Button>
      ) : null}
      {path !== '/' ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setSharing(true)}>
          <ShareNetworkIcon className="size-4" />
          <span className="hidden sm:inline">{t('shareFolder')}</span>
        </Button>
      ) : null}
    </div>
  );

  return (
    <FileExplorerSourceProvider value={source}>
      <DriveConflictsBanner
        driveId={drive.driveId}
        onOpenFolder={(p) => navigateToPath(p.replace(/^\//, ''))}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <DriveExplorer leading={leading} rootLabel={t('files')} />
      </div>
      <FolderAccessDialog driveId={drive.driveId} path={path} open={sharing} onOpenChange={setSharing} />
    </FileExplorerSourceProvider>
  );
}
