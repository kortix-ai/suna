'use client';

import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { Skeleton } from '@kortix/ui/skeleton';
import {
  createFilesStore,
  useFilesStore,
  useFilesStoreApi,
} from '@kortix/ui/internal/stores/files-store';
import { Home } from '@kortix/ui/internal/icons/home';
import { ErrorState } from '@kortix/ui/error-state';
import {
  DriveExplorer,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  drivePathFromParam,
  drivePathToParam,
  driveUrlWithPath,
  useDriveAvailability,
  useDriveFolder,
  useDriveUsage,
  useFolderAccess,
  useProjectDrive,
} from '@kortix/ui/files';
import Hint from '@kortix/ui/hint';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { type Drive, getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  FolderSimpleIcon,
  HardDriveIcon,
  LockSimpleIcon,
  ShareNetworkIcon,
  TerminalWindowIcon,
  UserIcon,
  UsersIcon,
  ListIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDebounce } from '@kortix/ui';
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from 'react';

import { DriveConflictsBar } from './drive-conflicts-bar';
import {
  DriveFilesProvider,
  driveExplorerSource,
  parentDrivePath,
  toDrivePath,
} from './drive-explorer-source';
import { useBoxPaths } from './drive-box-path';
import { DriveFolderTree } from './drive-folder-tree';
import { FolderAccessDialog } from './folder-access-dialog';
import { FolderAccessPanel } from './folder-access-panel';
import { folderAudience } from './folder-audience';

/**
 * /workspaces/[id]/drive — the project's Drive: one folder tree, stored as one
 * volume, that everyone in the project works in. The top is the project
 * itself; under it the folders as they are stored (Company, Users, Channels,
 * team folders), each opening for whoever may open it. A folder tree beside
 * the grid or list moves through it. A folder's header names who can open it
 * and where sessions see it. A person's own folder (`Users/<name>`) opens for
 * its owner and the project's admins; each admin open is recorded for the owner.
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
    if (off) router.replace(`/workspaces/${projectId}/files`);
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
    body = <FilesBrowser drive={drive.data} projectId={projectId} projectName={detail.data?.project.name ?? t('driveLabel')} />;
  }

  return <div className="bg-background flex h-full min-h-0 flex-1 flex-col">{body}</div>;
}

function FilesBrowser({ drive, projectId, projectName }: { drive: Drive; projectId: string; projectName: string }) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  // Read once: the URL picks the folder to open; after that the store leads.
  // Without one, Drive opens on My files, the one place every person has.
  const [openAt] = useState(() => {
    const param = searchParams.get('path');
    return param ? drivePathFromParam(param, drive.personalFolder) : (drive.personalFolder ?? '/');
  });
  const store = useMemo(() => {
    const s = createFilesStore();
    // Root held to `/`, so "home" (the root crumb, an empty path) is the top
    // of Files and never the sandbox default `/workspace`, which Files has not.
    s.setState({ currentPath: openAt, rootPath: '/', expandedDirs: new Set() });
    return s;
  }, [openAt]);
  return (
    <DriveFilesProvider driveId={drive.driveId} userId={user?.id} personalFolder={drive.personalFolder}>
      <FilesStoreProvider store={store}>
        <DrivePathInUrl personal={drive.personalFolder} />
        <FilesExplorer drive={drive} projectId={projectId} projectName={projectName} />
      </FilesStoreProvider>
    </DriveFilesProvider>
  );
}

/**
 * Writes the folder in view to `?path=` (see `drive-path-param.ts`), so a
 * reload or a shared link opens it, and the sidebar marks the place. 300 ms
 * after the last move, through `history.replaceState`: no history entry per folder.
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
    // `null`, not `window.history.state`: Next syncs `useSearchParams` only for
    // a replace that does not carry its own marker, and the sidebar's Drive
    // places read the folder from `?path=`. Still no history entry per folder.
    if (next !== now) window.history.replaceState(null, '', next);
  }, [debouncedValue, personal]);
  return null;
}

function FilesExplorer({ drive, projectId, projectName }: { drive: Drive; projectId: string; projectName: string }) {
  const router = useRouter();
  const t = useTranslations('drives');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const path = toDrivePath(currentPath);
  const folder = useDriveFolder(drive.driveId, path);
  const access = folder.data?.access ?? 'none';
  // People (`/Users`) holds the tree together: nothing is made or shared there.
  const structural = path === PEOPLE_ROOT;
  const canWrite = !structural && (access === 'write' || access === 'manage');
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
  // the API refuses the rest anyway. A file over the largest one file
  // (the folder-mount cap) is refused before any byte moves.
  const usage = useDriveUsage(drive.driveId);
  const maxUploadBytes = usage.data?.limits.fileBytes ?? null;
  const source = useMemo(
    () => ({
      ...driveExplorerSource,
      capabilities: { ...driveExplorerSource.capabilities, write: canWrite, maxUploadBytes },
    }),
    [canWrite, maxUploadBytes],
  );
  const open = (p: string) => navigateToPath(p.replace(/^\//, '') || '/');
  const boxPath = useBoxPaths(drive)(path);
  // People's own folders list under their names (`/Users/ana.lima` → "Ana Lima").
  const people = useDriveFolder(drive.driveId, PEOPLE_ROOT);
  const personNames = new Map((people.data?.entries ?? []).map((e) => [e.path, e.name] as const));
  const here = locateInDrive(path, drive, t, projectName, personNames);
  const HereGlyph = here.icon;
  // My files or a shared folder reads as its own root: `Users/<name>` and the
  // folders above a share are storage paths, not places people go.
  const base = here.base ? { path: here.base, label: here.label, icon: <HereGlyph /> } : undefined;
  const location = {
    icon: <HereGlyph />,
    crumbs: [
      here.label,
      ...path
        .split('/')
        .filter(Boolean)
        .slice(here.base ? here.base.split('/').filter(Boolean).length : 0),
    ],
  };

  // The action row's start names the place: Drive at the top, else the
  // folder with who can open it.
  const leading = (
    <div className="flex min-w-0 items-center gap-1">
      <DriveJump drive={drive} projectName={projectName} onOpen={open} />
      {path === '/' ? <PlaceTitle icon={HardDriveIcon} title={projectName} /> : <FolderTitle drive={drive} path={path} label={nameOfPath(path, here)} />}
    </div>
  );
  // Where sessions see the folder, then Share. A folder the caller only
  // passes through (on the way to a share) has no sharing they may see, and
  // nothing is shared while `shared_drives` is off.
  const trailing =
    path !== '/' && !structural && access !== 'none' ? (
      <>
        {boxPath ? <BoxPathChip path={boxPath} /> : null}
        {drive.sharedDrives ? (
        <Popover open={accessOpen} onOpenChange={setAccessOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="secondary" size="sm" className="gap-1.5 active:scale-[0.96]">
              <ShareNetworkIcon className="size-3.5 shrink-0" />
              <span className="hidden sm:inline">{t('shareFolder')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-88 p-4">
            <FolderAccessPanel
              driveId={drive.driveId}
              path={path}
              name={nameOfPath(path, here)}
              onManage={() => {
                setAccessOpen(false);
                setSharing(true);
              }}
            />
          </PopoverContent>
        </Popover>
        ) : null}
      </>
    ) : undefined;

  return (
    <FileExplorerSourceProvider value={source}>
      <div className="flex min-h-0 min-w-0 flex-1">
      <DriveFolderTree drive={drive} rootLabel={projectName} path={path} onOpen={open} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <DriveExplorer
          leading={leading}
          trailing={trailing}
          rootLabel={projectName}
          rootIcon={<HardDriveIcon className="text-muted-foreground" />}
          location={location}
          pathBase={base}
          onTeamFolderCreated={
            drive.sharedDrives
              ? (p, audience) => {
                  // Specific agents: open the new Drive and pick them there.
                  if (audience !== 'specific') return;
                  open(p);
                  setSharing(true);
                }
              : undefined
          }
          onOpenFolder={(p) =>
            router.push(
              driveUrlWithPath(
                `${window.location.origin}/workspaces/${projectId}/drive`,
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

const PEOPLE_ROOT = '/Users';

/** `/Users/<name>` for any path inside a person's own folder, else null. */
function personFolderOf(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  return parts.length >= 2 && `/${parts[0]}` === PEOPLE_ROOT ? `/${parts[0]}/${parts[1]}` : null;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

type DriveGlyph = ComponentType<{ className?: string }>;

/**
 * Where a path is: My files, a shared Drive, or a folder of the tree.
 * `base` is the folder that reads as the root there (My files, a shared
 * Drive), so `Users/<name>` never shows as a crumb.
 */
function locateInDrive(
  path: string,
  drive: Drive,
  t: ReturnType<typeof useTranslations>,
  projectName: string,
  personNames: ReadonlyMap<string, string>,
): { icon: DriveGlyph; label: string; base?: string } {
  const personal = drive.personalFolder;
  const person = personFolderOf(path);
  const nameOf = (folder: string) => personNames.get(folder) ?? folder.split('/').pop() ?? folder;
  if (person && person === personal) return { icon: Home, label: t('myDrive'), base: person };
  const shared = (drive.sharedWithMe ?? []).find((f) => isUnder(path, f.path));
  if (shared) return { icon: HardDriveIcon, label: shared.path.split('/').filter(Boolean).pop() ?? shared.path, base: shared.path };
  if (person) return { icon: UserIcon, label: nameOf(person), base: person };
  return { icon: HardDriveIcon, label: projectName };
}

function nameOfPath(path: string, here: { label: string; base?: string }): string {
  if (here.base === path) return here.label;
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * Small screens have no folder tree: one menu jumps to My files and, with
 * `shared_drives` on, the shared Drives the caller reaches and (an admin) the
 * top of the Drive.
 */
function DriveJump({ drive, projectName, onOpen }: { drive: Drive; projectName: string; onOpen: (path: string) => void }) {
  const t = useTranslations('drives');
  const shared = drive.sharedDrives ? (drive.sharedWithMe ?? []) : [];
  return (
    <div className="md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="icon-sm" aria-label={t('folderTree')}>
            <ListIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {drive.personalFolder ? (
            <DropdownMenuItem onSelect={() => onOpen(drive.personalFolder!)}>
              <Home className="size-4 shrink-0" />
              {t('myDrive')}
            </DropdownMenuItem>
          ) : null}
          {drive.sharedDrives && drive.access === 'manage' ? (
            <DropdownMenuItem onSelect={() => onOpen('/')}>
              <HardDriveIcon className="size-4 shrink-0" />
              <span className="truncate">{projectName}</span>
            </DropdownMenuItem>
          ) : null}
          {shared.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t('drivesSection')}</DropdownMenuLabel>
              {shared.map((f) => (
                <DropdownMenuItem key={f.path} onSelect={() => onOpen(f.path)}>
                  <HardDriveIcon className="size-4 shrink-0" />
                  <span className="truncate">{f.path.split('/').filter(Boolean).pop() ?? f.path}</span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PlaceTitle({ icon: Glyph, title, meta }: { icon: DriveGlyph; title: string; meta?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Glyph className="text-muted-foreground size-4 shrink-0" />
      <h1 className="text-foreground truncate text-sm font-medium">{title}</h1>
      {meta ? <span className="text-muted-foreground hidden min-w-0 items-center gap-1 truncate text-xs md:flex">{meta}</span> : null}
    </div>
  );
}

/** A folder's name and who can open it: Everyone, Admins only, how many people, or its owner. */
function FolderTitle({ drive, path, label }: { drive: Drive; path: string; label: string }) {
  const t = useTranslations('drives');
  const access = useFolderAccess(drive.driveId, path);
  const audience = access.data ? folderAudience(access.data.grants) : null;
  const personal = drive.personalFolder;
  const inPeople = isUnder(path, PEOPLE_ROOT);
  let meta: ReactNode = null;
  if (path === PEOPLE_ROOT) return <PlaceTitle icon={UsersIcon} title={label} />;
  if (personal && isUnder(path, personal)) meta = t('folderInfo.audienceYouAndAdmins');
  else if (audience?.mode === 'specific' && audience.named.length > 0)
    meta = t('folderInfo.audienceAgentUsers', { agent: audience.named.map((n) => n.label).join(', ') });
  else if (inPeople) meta = (
    <>
      <LockSimpleIcon className="size-3" />
      {t('folderInfo.audienceOwnerAndAdmins')}
    </>
  );
  else if (audience?.mode === 'restricted') meta = (
    <>
      <LockSimpleIcon className="size-3" />
      {t('audienceAdmins')}
    </>
  );
  const glyph = personal && path === personal ? Home : inPeople ? UserIcon : FolderSimpleIcon;
  return <PlaceTitle icon={glyph} title={label} meta={meta} />;
}

/** Where sessions see this folder, copyable: the same path under /drives, or ~/Desktop for your own. */
function BoxPathChip({ path }: { path: string }) {
  const t = useTranslations('drives');
  const [copied, setCopied] = useState(false);
  return (
    <Hint label={copied ? t('folderInfo.pathCopied') : t('folderInfo.boxPathHint')}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="hidden max-w-64 gap-1.5 font-mono lg:inline-flex"
        onClick={() => {
          void navigator.clipboard?.writeText(path).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <TerminalWindowIcon className="size-3.5 shrink-0" />
        <span className="truncate">{path}</span>
      </Button>
    </Hint>
  );
}
