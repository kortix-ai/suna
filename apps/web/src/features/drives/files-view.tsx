'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createFilesStore,
  useFilesStore,
  useFilesStoreApi,
} from '@/features/file-browser/store/files-store';
import { Home } from '@/features/icon/icons/home';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  DriveExplorer,
  FileExplorerSourceProvider,
  FilesStoreProvider,
} from '@/features/project-files';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useDriveAvailability,
  useDriveFolder,
  useFolderAccess,
  useProjectDrive,
} from '@/hooks/drives/use-drives';
import { useDebounce } from '@/hooks/use-debounce';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { type Drive, getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CaretDownIcon,
  FolderSimpleIcon,
  HardDriveIcon,
  LockSimpleIcon,
  ShareNetworkIcon,
  ShieldIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from 'react';

import { DriveConflictsBar } from './drive-conflicts-bar';
import {
  DriveFilesProvider,
  driveExplorerSource,
  parentDrivePath,
  toDrivePath,
} from './drive-explorer-source';
import { drivePathFromParam, drivePathToParam, driveUrlWithPath } from './drive-path-param';
import { FolderAccessDialog } from './folder-access-dialog';
import { FolderAccessPanel } from './folder-access-panel';
import { folderAudience } from './folder-audience';

/**
 * /projects/[id]/drive — the project's Drive, a sidebar page: one folder tree
 * everyone in the project works in, in the same explorer as Repo. A rail on
 * the left (a switcher on small screens) picks where to look: My files,
 * folders shared with the caller, the team folders (the top-level folders,
 * each with who can open it), and for admins All files. It is one Drive: a
 * team folder is a folder, not a volume of its own. Share shows who can open
 * the folder in view. A person's own folder (`Users/<name>`) is private, even
 * from admins, until they share it, and is the desktop of their sessions.
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

  return <div className="bg-background flex h-full min-h-0 flex-1 flex-col">{body}</div>;
}

function FilesBrowser({ drive, projectId }: { drive: Drive; projectId: string }) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  // Read once: the URL picks the folder to open; after that the store leads.
  const [openAt] = useState(() =>
    drivePathFromParam(searchParams.get('path'), drive.personalFolder),
  );
  const store = useMemo(() => {
    const s = createFilesStore();
    // Root held to `/`, so "home" (the root crumb, an empty path) is the top
    // of Files and never the sandbox default `/workspace`, which Files has not.
    s.setState({ currentPath: openAt, rootPath: '/', expandedDirs: new Set() });
    return s;
  }, [openAt]);
  return (
    <DriveFilesProvider driveId={drive.driveId} userId={user?.id}>
      <FilesStoreProvider store={store}>
        <DrivePathInUrl personal={drive.personalFolder} />
        <FilesExplorer drive={drive} projectId={projectId} />
      </FilesStoreProvider>
    </DriveFilesProvider>
  );
}

/**
 * Writes the folder in view to `?path=` (see `drive-path-param.ts`), so a
 * reload or a shared link opens it. 300 ms after the last move, and through
 * `history.replaceState`: no route re-render, no history entry per folder.
 */
function DrivePathInUrl({ personal }: { personal: string | null }) {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const store = useFilesStoreApi();
  // And the other way: a link to `?path=` while Drive is open (the upload
  // toast's "Open folder") moves the view. Our own writes land here too and
  // match the store, so they do nothing.
  const param = useSearchParams().get('path');
  useEffect(() => {
    const want = drivePathFromParam(param, personal);
    if (want !== store.getState().currentPath) navigateToPath(want);
  }, [param, personal, store, navigateToPath]);
  const { debouncedValue } = useDebounce(currentPath, 300);
  useEffect(() => {
    const next = driveUrlWithPath(window.location.href, drivePathToParam(debouncedValue, personal));
    const now = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== now) window.history.replaceState(window.history.state, '', next);
  }, [debouncedValue, personal]);
  return null;
}

function FilesExplorer({ drive, projectId }: { drive: Drive; projectId: string }) {
  const router = useRouter();
  const t = useTranslations('drives');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const path = toDrivePath(currentPath);
  const folder = useDriveFolder(drive.driveId, path);
  const access = folder.data?.access ?? 'none';
  const canWrite = access === 'write' || access === 'manage';
  const [sharing, setSharing] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);

  // A folder that is gone (deleted, moved, or never there) is not an error
  // page: step up to the nearest folder that lists.
  const missing =
    folder.isError && path !== '/' && (folder.error as { status?: number } | null)?.status === 404;
  useEffect(() => {
    if (!missing) return;
    navigateToPath(parentDrivePath(path).replace(/^\//, '') || '/');
  }, [missing, path, navigateToPath]);

  // Upload, new folder, rename and delete only where the caller may write;
  // the API refuses the rest anyway.
  const source = useMemo(
    () => ({
      ...driveExplorerSource,
      capabilities: { ...driveExplorerSource.capabilities, write: canWrite },
    }),
    [canWrite],
  );
  const open = (p: string) => navigateToPath(p.replace(/^\//, '') || '/');
  const { locate } = useDriveLocation(drive);
  const here = locate(path);
  const HereGlyph = here.icon;
  // The drive's name, then the full path from the top of Drive.
  const location = {
    icon: <HereGlyph />,
    crumbs: [here.label, ...path.split('/').filter(Boolean)],
  };

  // The rail picks where to look; small screens keep the switcher.
  const leading = (
    <div className="md:hidden">
      <DriveSwitcher drive={drive} path={path} onOpen={open} />
    </div>
  );
  // Share closes the action group, after New and the view menu.
  const trailing =
    path !== '/' ? (
      <Popover open={accessOpen} onOpenChange={setAccessOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1.5 active:scale-[0.96]"
          >
            <ShareNetworkIcon className="size-3.5 shrink-0" />
            <span className="hidden sm:inline">{t('shareFolder')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-88 p-4">
          <FolderAccessPanel
            driveId={drive.driveId}
            path={path}
            onManage={() => {
              setAccessOpen(false);
              setSharing(true);
            }}
          />
        </PopoverContent>
      </Popover>
    ) : undefined;

  return (
    <FileExplorerSourceProvider value={source}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <DriveRail drive={drive} path={path} onOpen={open} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <DriveExplorer
            leading={leading}
            trailing={trailing}
            rootLabel={t('driveLabel')}
            rootIcon={<HardDriveIcon className="text-muted-foreground" />}
            location={location}
            onTeamFolderCreated={(p, audience) => {
              // Specific people: open the new folder and pick them there.
              if (audience !== 'specific') return;
              open(p);
              setSharing(true);
            }}
            onOpenFolder={(p) =>
              router.push(
                driveUrlWithPath(
                  `${window.location.origin}/projects/${projectId}/drive`,
                  drivePathToParam(p, drive.personalFolder),
                ),
              )
            }
          />
          <DriveConflictsBar driveId={drive.driveId} onOpenFolder={open} />
        </div>
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

/** Top-level folders that are not the per-person tree: the team folders. */
const PEOPLE_ROOT = '/Users';

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

type DriveGlyph = ComponentType<{ className?: string }>;

/**
 * Names where a path is, the way the rail does: My files, a team folder, a
 * folder shared with the caller, or All files. The
 * switcher's trigger and the create dialog both read it, so "where am I" has
 * one answer.
 */
function useDriveLocation(drive: Drive) {
  const t = useTranslations('drives');
  const root = useDriveFolder(drive.driveId, '/');
  const companyDrives = (root.data?.entries ?? [])
    .filter((e) => e.type === 'dir' && !isUnder(absolute(e.path), PEOPLE_ROOT))
    .map((e) => ({ name: e.name, path: absolute(e.path) }));
  const personal = drive.personalFolder;
  const shared = drive.sharedWithMe ?? [];

  const locate = (path: string): { icon: DriveGlyph; label: string } => {
    if (personal && isUnder(path, personal)) return { icon: Home, label: t('myDrive') };
    const company = companyDrives.find((d) => isUnder(path, d.path));
    if (company) return { icon: FolderSimpleIcon, label: company.name };
    const sharedHere = shared.find((f) => isUnder(path, f.path));
    if (sharedHere)
      return {
        icon: FolderSimpleIcon,
        label: sharedHere.path.split('/').filter(Boolean).pop() ?? sharedHere.path,
      };
    return { icon: SquaresFourIcon, label: t('allFiles') };
  };
  return { locate, companyDrives, isLoadingDrives: root.isLoading, personal, shared };
}

/**
 * The rail's choices as a menu, for screens too narrow for the rail. The
 * trigger names where the view is, so the header always answers "where am I".
 */
function DriveSwitcher({
  drive,
  path,
  onOpen,
}: {
  drive: Drive;
  path: string;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const { locate, companyDrives, isLoadingDrives, personal, shared } = useDriveLocation(drive);
  const isAdmin = drive.access === 'manage';
  const current = locate(path);
  const CurrentGlyph = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="gap-1.5 font-medium active:scale-[0.96]"
        >
          <CurrentGlyph className="size-4 shrink-0" />
          <span className="max-w-40 truncate">{current.label}</span>
          <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {personal ? (
          <DropdownMenuItem onSelect={() => onOpen(personal)} title={t('myFolderHint')}>
            <Home className="size-4 shrink-0" />
            <span className="flex-1 truncate">{t('myDrive')}</span>
          </DropdownMenuItem>
        ) : null}
        {isAdmin ? (
          <DropdownMenuItem onSelect={() => onOpen('/')}>
            <SquaresFourIcon className="size-4 shrink-0" />
            <span className="flex-1 truncate">{t('allFiles')}</span>
          </DropdownMenuItem>
        ) : null}
        {shared.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              {t('sharedWithMe')}
            </DropdownMenuLabel>
            {shared.map((f) => (
              <DropdownMenuItem key={f.path} onSelect={() => onOpen(f.path)} title={f.path}>
                <FolderSimpleIcon className="size-4 shrink-0" />
                <span className="flex-1 truncate">
                  {f.path.split('/').filter(Boolean).pop() ?? f.path}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {t('teamFolders')}
        </DropdownMenuLabel>
        {isLoadingDrives ? (
          <div className="space-y-1 px-2 py-1">
            <Skeleton className="h-6 w-full rounded-sm" />
            <Skeleton className="h-6 w-3/4 rounded-sm" />
          </div>
        ) : companyDrives.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">{t('noTeamFolders')}</p>
        ) : (
          companyDrives.map((d) => (
            <DropdownMenuItem key={d.path} onSelect={() => onOpen(d.path)}>
              <FolderSimpleIcon className="size-4 shrink-0" />
              <span className="flex-1 truncate">{d.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where to look in Drive, always in view: My files, what others shared with
 * the caller, the team folders with who can open each, and for admins All
 * files. A team folder that nobody was given reads "Admins only" with a lock,
 * so an admin-only folder is never one by accident.
 */
function DriveRail({
  drive,
  path,
  onOpen,
}: {
  drive: Drive;
  path: string;
  onOpen: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const { companyDrives: teamFolders, isLoadingDrives, personal, shared } = useDriveLocation(drive);
  const isAdmin = drive.access === 'manage';

  return (
    <nav
      aria-label={t('driveLabel')}
      className="border-border hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r p-2 md:flex"
    >
      <div className="flex flex-col gap-0.5">
        {personal ? (
          <RailRow
            icon={Home}
            label={t('myDrive')}
            meta={t('audienceOnlyYou')}
            active={isUnder(path, personal)}
            onClick={() => onOpen(personal)}
          />
        ) : null}
      </div>
      {shared.length > 0 ? (
        <RailSection label={t('sharedWithMe')}>
          {shared.map((f) => (
            <RailRow
              key={f.path}
              icon={FolderSimpleIcon}
              label={f.path.split('/').filter(Boolean).pop() ?? f.path}
              title={f.path}
              active={isUnder(path, f.path)}
              onClick={() => onOpen(f.path)}
            />
          ))}
        </RailSection>
      ) : null}
      <RailSection label={t('teamFolders')}>
        {isLoadingDrives ? (
          <div className="space-y-1 px-2 py-1">
            <Skeleton className="h-6 w-full rounded-sm" />
            <Skeleton className="h-6 w-3/4 rounded-sm" />
          </div>
        ) : teamFolders.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1 text-xs">{t('noTeamFolders')}</p>
        ) : (
          teamFolders.map((d) => (
            <TeamFolderRow
              key={d.path}
              driveId={drive.driveId}
              name={d.name}
              path={d.path}
              active={isUnder(path, d.path)}
              onClick={() => onOpen(d.path)}
            />
          ))
        )}
      </RailSection>
      {isAdmin ? (
        <RailSection label={t('adminSection')}>
          <RailRow
            icon={ShieldIcon}
            label={t('allFiles')}
            active={path === '/'}
            onClick={() => onOpen('/')}
          />
        </RailSection>
      ) : null}
      <p className="text-muted-foreground mt-auto px-2 pb-1 text-xs">{t('privateNote')}</p>
    </nav>
  );
}

function RailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground px-2 pb-1 text-xs">{label}</p>
      {children}
    </div>
  );
}

function RailRow({
  icon: Glyph,
  label,
  meta,
  title,
  active,
  onClick,
}: {
  icon: DriveGlyph;
  label: string;
  meta?: ReactNode;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
        active ? 'bg-accent text-foreground font-medium' : 'text-foreground/85 hover:bg-accent/60',
      )}
    >
      <Glyph className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs font-normal">
          {meta}
        </span>
      ) : null}
    </button>
  );
}

/** A team folder and who can open it: Everyone, Admins only, or how many people. */
function TeamFolderRow({
  driveId,
  name,
  path,
  active,
  onClick,
}: {
  driveId: string;
  name: string;
  path: string;
  active: boolean;
  onClick: () => void;
}) {
  const t = useTranslations('drives');
  const access = useFolderAccess(driveId, path);
  const audience = access.data ? folderAudience(access.data.grants) : null;
  const meta =
    audience?.mode === 'everyone' ? (
      t('badgeEveryone')
    ) : audience?.mode === 'restricted' ? (
      <>
        <LockSimpleIcon className="size-3" />
        {t('audienceAdmins')}
      </>
    ) : audience?.mode === 'specific' ? (
      t('badgePeople', { count: audience.named.length })
    ) : undefined;
  return (
    <RailRow icon={FolderSimpleIcon} label={name} meta={meta} active={active} onClick={onClick} />
  );
}
