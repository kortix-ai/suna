'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { createFilesStore, useFilesStore } from '@/features/file-browser/store/files-store';
import { ErrorState } from '@/features/layout/section/error-state';
import { DriveExplorer, FileExplorerSourceProvider, FilesStoreProvider } from '@/features/project-files';
import { useDriveAvailability, useDriveFolder, useProjectDrive } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import {
  FolderSimpleIcon,
  HardDriveIcon,
  HouseIcon,
  type Icon,
  ShareNetworkIcon,
  SquaresFourIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { type Drive, getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { DriveConflictsBar } from './drive-conflicts-bar';
import { DriveFilesProvider, driveExplorerSource, parentDrivePath, toDrivePath } from './drive-explorer-source';
import { FolderAccessDialog } from './folder-access-dialog';
import { FolderAccessPanel } from './folder-access-panel';

/**
 * /projects/[id]/drive — the project's Drive, a sidebar page: one folder tree
 * everyone in the project works in, in the same explorer as Repo. A rail
 * beside the explorer separates My drive, folders shared with the caller, and
 * the shared drives (each top-level folder, its own volume). What each person sees and
 * may change follows folder access; their own folder (`Users/<name>`) is
 * private until they share it and is the desktop of their sessions.
 */
export function FilesView({ projectId }: { projectId: string }) {
  const t = useTranslations('drives');
  const availability = useDriveAvailability(projectId);
  const drive = useProjectDrive(projectId, availability.enabled);
  const router = useRouter();
  // Volumes off for the project: there is no drive page; Files is the repo browser.
  // Trust only a fresh answer: a cached one may predate a switch flip.
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const settled = detail.isFetchedAfterMount || (detail.isSuccess && !detail.isStale);
  const off = settled && !detail.isFetching && !availability.enabled;
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
    body = <FilesBrowser drive={drive.data} projectId={projectId} />;
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-1 flex-col">
      {body}
    </div>
  );
}

function FilesBrowser({ drive, projectId }: { drive: Drive; projectId: string }) {
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
        <FilesExplorer drive={drive} projectId={projectId} />
      </FilesStoreProvider>
    </DriveFilesProvider>
  );
}

function FilesExplorer({ drive, projectId }: { drive: Drive; projectId: string }) {
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
          className="md:hidden"
          onClick={() => navigateToPath(drive.personalFolder!.replace(/^\//, ''))}
          title={t('myFolderHint')}
        >
          <HouseIcon className="size-4" />
          <span className="hidden sm:inline">{t('myFolder')}</span>
        </Button>
      ) : null}
      {drive.sharedWithMe?.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="md:hidden" title={t('sharedWithMeHint')}>
              <UsersThreeIcon className="size-4" />
              <span className="hidden sm:inline">{t('sharedWithMe')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              {t('sharedWithMeHint')}
            </DropdownMenuLabel>
            {drive.sharedWithMe.map((folder) => (
              <DropdownMenuItem key={folder.path} onSelect={() => navigateToPath(folder.path.replace(/^\//, ''))}>
                <FolderSimpleIcon className="size-4 shrink-0" />
                <span className="truncate" title={folder.path}>
                  {folder.path.replace(/^\//, '')}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
      <div className="flex min-h-0 flex-1">
        <DriveRail drive={drive} path={path} onOpen={(p) => navigateToPath(p.replace(/^\//, '') || '/')} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <DriveExplorer leading={leading} rootLabel={t('driveLabel')} />
          <DriveConflictsBar
            driveId={drive.driveId}
            onOpenFolder={(p) => navigateToPath(p.replace(/^\//, ''))}
          />
        </div>
        {/* Who can open the folder in view, beside it: the same section an
            agent's page shows for who can use the agent. */}
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l p-4 lg:block">
          <FolderAccessPanel driveId={drive.driveId} path={path} onManage={() => setSharing(true)} />
        </aside>
      </div>
      <FolderAccessDialog
        driveId={drive.driveId}
        projectId={projectId}
        path={path}
        open={sharing}
        onOpenChange={setSharing}
      />
    </FileExplorerSourceProvider>
  );
}

/** Top-level folders that are not the per-person tree: the shared drives. */
const PEOPLE_ROOT = '/Users';

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Where a person goes in Drive, in the order they reach for it: their own
 * drive, what others shared with them, then the shared drives. A shared
 * drive is its own volume (sessions mount it alone under /drives), so it
 * carries the drive glyph; a folder inside one carries the folder glyph in
 * the explorer. The glyph is the whole volume-or-folder signal: no badge.
 */
function DriveRail({ drive, path, onOpen }: { drive: Drive; path: string; onOpen: (path: string) => void }) {
  const t = useTranslations('drives');
  const root = useDriveFolder(drive.driveId, '/');
  const sharedDrives = (root.data?.entries ?? []).filter(
    (e) => e.type === 'dir' && !isUnder(e.path.startsWith('/') ? e.path : `/${e.path}`, PEOPLE_ROOT),
  );
  const personal = drive.personalFolder;
  const inPersonal = !!personal && isUnder(path, personal);
  const shared = drive.sharedWithMe ?? [];
  const isAdmin = drive.access === 'manage';

  return (
    <nav aria-label={t('driveLabel')} className="hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto border-r px-2 py-3 md:flex">
      <ul className="space-y-px">
        {personal ? (
          <RailRow icon={HouseIcon} label={t('myDrive')} hint={t('myFolderHint')} active={inPersonal} onClick={() => onOpen(personal)} />
        ) : null}
        {isAdmin ? (
          <RailRow icon={SquaresFourIcon} label={t('allFiles')} active={path === '/'} onClick={() => onOpen('/')} />
        ) : null}
      </ul>

      {shared.length > 0 ? (
        <RailGroup label={t('sharedWithMe')}>
          {shared.map((f) => (
            <RailRow
              key={f.path}
              icon={FolderSimpleIcon}
              label={f.path.split('/').filter(Boolean).pop() ?? f.path}
              hint={f.path}
              active={isUnder(path, f.path)}
              onClick={() => onOpen(f.path)}
            />
          ))}
        </RailGroup>
      ) : null}

      <RailGroup label={t('companyDrives')}>
        {root.isLoading ? (
          <li className="space-y-1 px-2">
            <Skeleton className="h-6 w-full rounded-sm" />
            <Skeleton className="h-6 w-3/4 rounded-sm" />
          </li>
        ) : sharedDrives.length === 0 ? (
          <li className="text-muted-foreground px-2 py-1 text-xs">{t('noCompanyDrives')}</li>
        ) : (
          sharedDrives.map((e) => {
            const p = e.path.startsWith('/') ? e.path : `/${e.path}`;
            return (
              <RailRow
                key={p}
                icon={HardDriveIcon}
                label={e.name}
                hint={t('volumeHint')}
                active={isUnder(path, p)}
                onClick={() => onOpen(p)}
              />
            );
          })
        )}
      </RailGroup>
    </nav>
  );
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-muted-foreground px-2 text-xs font-medium">{label}</h3>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

function RailRow({
  icon: Glyph,
  label,
  hint,
  active,
  onClick,
}: {
  icon: Icon;
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-fast',
        active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Glyph className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
  return <li>{hint ? <Hint label={hint} side="right">{row}</Hint> : row}</li>;
}
