'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import {
  useCreateDrive,
  useDeleteDrive,
  useDriveAvailability,
  useDrives,
  useRenameDrive,
  useSetDriveGrant,
} from '@/hooks/drives/use-drives';
import { useFormatter, useLocale, useNow, useTranslations } from '@/i18n/use-translations';
import {
  DotsThreeIcon,
  HardDrivesIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { DriveAccessDialog } from './drive-access-dialog';
import { DriveConflictsBanner } from './drive-conflicts-banner';
import { DriveFileBrowser } from './drive-file-browser';
import { DriveGrantRow } from './drive-grant-row';
import { DriveList, DriveListSkeleton } from './drive-list';
import {
  type DriveRecord,
  canManageDrive,
  canWriteDrive,
  formatBytes,
  groupDrives,
} from './drive-model';
import { driveMountPath } from './drive-mount';
import { DriveNameModal } from './drive-name-modal';
import { DriveVersions } from './drive-versions';

type DriveTab = 'files' | 'versions';

/**
 * /projects/[id]/drive — the caller's drives as seen from one project: their
 * own, the company drives this project can use, and the project's agent
 * drives. Every session in the project mounts the relevant ones under /drives.
 */
export function DriveView({ projectId }: { projectId: string }) {
  const t = useTranslations('drives');
  const sidebar = useOptionalSidebar();
  const availability = useDriveAvailability(projectId);
  const drives = useDrives(projectId, availability.enabled);
  const accounts = useAccountsList();
  const accountRole = accounts.data?.find(
    (a) => a.account_id === availability.accountId,
  )?.account_role;
  const canCreateCompany = accountRole === 'owner' || accountRole === 'admin';
  const createDrive = useCreateDrive();
  const setGrant = useSetDriveGrant();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [location, setLocation] = useState<{ driveId: string | null; path: string }>({
    driveId: null,
    path: '/',
  });
  const [tab, setTab] = useState<DriveTab>('files');
  const [creating, setCreating] = useState<'personal' | 'company' | null>(null);

  const list = useMemo(() => drives.data ?? [], [drives.data]);
  // The explicit choice while it exists; otherwise the caller's default drive.
  // A drive created a moment ago may be missing until the list refetches, so
  // hold off on the fallback while that refetch is in flight.
  const explicit = list.find((drive) => drive.driveId === selectedId) ?? null;
  const fallback =
    list.find((drive) => drive.kind === 'personal' && drive.isDefault) ?? list[0] ?? null;
  const selected = explicit ?? (selectedId && drives.isFetching ? null : fallback);
  const path = selected && location.driveId === selected.driveId ? location.path : '/';

  const navigate = (next: string) =>
    setLocation({ driveId: selected?.driveId ?? null, path: next });

  const select = (driveId: string) => {
    if (driveId !== selected?.driveId) setTab('files');
    setSelectedId(driveId);
    setLocation({ driveId, path: '/' });
  };

  const submitCreate = (name: string, grantHere: boolean) => {
    if (!creating) return;
    const kind = creating;
    createDrive.mutate(
      // The project's account: a drive made here must show up here.
      { name, kind, accountId: availability.accountId ?? undefined },
      {
        onSuccess: (drive) => {
          setCreating(null);
          successToast(t('driveCreated'));
          if (drive?.driveId) select(drive.driveId);
          if (kind === 'company' && grantHere && drive?.driveId) {
            setGrant.mutate(
              { driveId: drive.driveId, projectId, access: 'write' },
              { onError: () => errorToast(t('grantFailed')) },
            );
          }
        },
        onError: () => errorToast(t('driveCreateFailed')),
      },
    );
  };

  return (
    <div className="bg-background flex h-full min-h-0 flex-1 flex-col">
      <header
        className="kx-titlebar-row kx-titlebar-band-height relative flex h-11 shrink-0 items-center gap-1 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <h1 className="text-foreground px-3 text-sm font-medium">{t('title')}</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        {availability.enabled || availability.isLoading ? (
          <aside className="bg-sidebar hidden w-60 shrink-0 overflow-y-auto border-r md:block">
            {availability.isLoading || drives.isLoading ? (
              <DriveListSkeleton />
            ) : (
              <DriveList
                drives={list}
                selectedDriveId={selected?.driveId ?? null}
                onSelect={select}
                onCreate={setCreating}
                canCreateCompany={canCreateCompany}
              />
            )}
          </aside>
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col">
          {availability.isLoading || drives.isLoading ? (
            <PaneSkeleton />
          ) : !availability.enabled ? (
            <EmptyState
              className="h-full"
              icon={HardDrivesIcon}
              title={t('unavailableTitle')}
              description={t('unavailableDescription')}
            />
          ) : drives.isError ? (
            <ErrorState
              title={t('loadError')}
              className="h-full"
              action={
                <Button variant="outline" size="sm" onClick={() => void drives.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : !selected ? (
            <EmptyState className="h-full" icon={HardDrivesIcon} title={t('selectDrive')} />
          ) : (
            <>
              <MobileDrivePicker
                drives={list}
                value={selected.driveId}
                onChange={select}
                onCreate={setCreating}
                canCreateCompany={canCreateCompany}
              />
              <DrivePane
                key={selected.driveId}
                drive={selected}
                projectId={projectId}
                path={path}
                onNavigate={navigate}
                tab={tab}
                onTabChange={setTab}
              />
            </>
          )}
        </main>
      </div>

      <DriveNameModal
        open={creating !== null}
        onOpenChange={(open) => (open ? undefined : setCreating(null))}
        title={creating === 'company' ? t('createCompanyTitle') : t('createPersonalTitle')}
        description={
          creating === 'company' ? t('createCompanyDescription') : t('createPersonalDescription')
        }
        label={t('driveNameLabel')}
        submitLabel={t('create')}
        toggle={
          creating === 'company'
            ? { label: t('grantTitle'), description: t('grantOnCreate'), defaultChecked: true }
            : undefined
        }
        isPending={createDrive.isPending}
        onSubmit={submitCreate}
      />
    </div>
  );
}

function DrivePane({
  drive,
  projectId,
  path,
  onNavigate,
  tab,
  onTabChange,
}: {
  drive: DriveRecord;
  projectId: string;
  path: string;
  onNavigate: (path: string) => void;
  tab: DriveTab;
  onTabChange: (tab: DriveTab) => void;
}) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const rename = useRenameDrive();
  const remove = useDeleteDrive();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);

  const mountPath = driveMountPath(drive);
  const readOnly = !canWriteDrive(drive);
  const canShare = manageable(drive) && drive.kind !== 'agent';
  // The server refuses these to anyone who does not manage the drive.
  const manage = canManageDrive(drive);
  const canRename = manage && drive.kind !== 'agent';
  const canDelete =
    manage && (drive.kind === 'company' || (drive.kind === 'personal' && !drive.isDefault));

  const meta = [
    drive.shared && drive.ownerEmail ? t('sharedBy', { email: drive.ownerEmail }) : null,
    typeof drive.fileCount === 'number' ? t('fileCount', { count: drive.fileCount }) : null,
    typeof drive.sizeBytes === 'number'
      ? typeof drive.sizeLimitBytes === 'number' && drive.sizeLimitBytes > 0
        ? t('sizeOfLimit', {
            size: formatBytes(drive.sizeBytes, locale),
            limit: formatBytes(drive.sizeLimitBytes, locale),
          })
        : formatBytes(drive.sizeBytes, locale)
      : null,
    drive.lastChangeAt
      ? t('updatedAgo', { time: format.relativeTime(new Date(drive.lastChangeAt), now) })
      : null,
    mountPath && drive.kind === 'personal' && !drive.shared
      ? t('mountedAtPrivate', { path: mountPath })
      : null,
    mountPath && drive.kind === 'agent' ? t('mountedAt', { path: mountPath }) : null,
  ].filter(Boolean);

  const controls = (
    <>
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as DriveTab)}>
        <TabsListCompact>
          <TabsTriggerCompact value="files">{t('files')}</TabsTriggerCompact>
          <TabsTriggerCompact value="versions">{t('versions')}</TabsTriggerCompact>
        </TabsListCompact>
      </Tabs>
      {canShare ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setSharing(true)}
          className="text-muted-foreground hover:text-foreground"
        >
          <UsersIcon className="size-4 shrink-0" />
          <span className="hidden sm:inline">
            {drive.kind === 'personal' ? t('share') : t('manageAccess')}
          </span>
        </Button>
      ) : null}
      {canRename || canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('driveActions')}
              className="text-muted-foreground hover:text-foreground"
            >
              <DotsThreeIcon className="size-4 shrink-0" weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canRename ? (
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <PencilSimpleIcon className="size-4 shrink-0" />
                {t('renameDrive')}
              </DropdownMenuItem>
            ) : null}
            {canRename && canDelete ? <DropdownMenuSeparator /> : null}
            {canDelete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                <TrashIcon className="size-4 shrink-0" />
                {t('deleteDrive')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
  const banner = (
    <>
      <DriveConflictsBanner
        driveId={drive.driveId}
        canWrite={!readOnly}
        onOpenFolder={onNavigate}
      />
      {drive.kind === 'company' ? <DriveGrantRow drive={drive} projectId={projectId} /> : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === 'files' ? (
        <DriveFileBrowser
          driveId={drive.driveId}
          driveName={drive.name}
          path={path}
          onNavigate={onNavigate}
          controls={controls}
          banner={banner}
          meta={meta.join(' · ')}
          readOnly={readOnly}
        />
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
            <p className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{drive.name}</p>
            <div className="flex shrink-0 items-center gap-1">{controls}</div>
          </div>
          {banner}
          <DriveVersions driveId={drive.driveId} />
        </>
      )}

      <DriveNameModal
        open={renaming}
        onOpenChange={setRenaming}
        title={t('renameDrive')}
        label={t('driveNameLabel')}
        submitLabel={t('save')}
        initialValue={drive.name}
        isPending={rename.isPending}
        onSubmit={(name) =>
          rename.mutate(
            { driveId: drive.driveId, name },
            {
              onSuccess: () => {
                setRenaming(false);
                successToast(t('renamed'));
              },
              onError: () => errorToast(t('renameFailed')),
            },
          )
        }
      />

      {canShare ? (
        <DriveAccessDialog
          drive={drive}
          projectId={projectId}
          open={sharing}
          onOpenChange={setSharing}
        />
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteDriveTitle', { name: drive.name })}
        description={t('deleteDriveDescription')}
        confirmLabel={t('deleteDrive')}
        cancelLabel={t('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(drive.driveId, {
            onSuccess: () => {
              setDeleting(false);
              successToast(t('driveDeleted'));
            },
            onError: () => errorToast(t('driveDeleteFailed')),
          })
        }
      />
    </div>
  );
}

/** Rename, delete and grant: the owner of a personal drive, an admin of a company drive. */
function manageable(drive: DriveRecord): boolean {
  return canManageDrive(drive) && !drive.shared;
}

/** Below `md` the rail is hidden; one select stands in for it. */
function MobileDrivePicker({
  drives,
  value,
  onChange,
  onCreate,
  canCreateCompany,
}: {
  drives: DriveRecord[];
  value: string;
  onChange: (driveId: string) => void;
  onCreate: (kind: 'personal' | 'company') => void;
  canCreateCompany: boolean;
}) {
  const t = useTranslations('drives');
  const groups = groupDrives(drives);
  const sections = [
    { label: t('myDrives'), items: groups.personal },
    { label: t('sharedWithMe'), items: groups.shared },
    { label: t('companyDrives'), items: groups.company },
    { label: t('agentDrives'), items: groups.agent },
  ].filter((section) => section.items.length > 0);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 md:hidden">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={t('selectDrive')} className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sections.map((section) => (
            <SelectGroup key={section.label}>
              <SelectLabel>{section.label}</SelectLabel>
              {section.items.map((drive) => (
                <SelectItem key={drive.driveId} value={drive.driveId}>
                  {drive.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('newDrive')}>
            <PlusIcon className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onCreate('personal')}>
            {t('newPersonalDrive')}
          </DropdownMenuItem>
          {canCreateCompany ? (
            <DropdownMenuItem onSelect={() => onCreate('company')}>
              {t('newCompanyDrive')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PaneSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden>
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-4 w-32 rounded-sm" />
        <Skeleton className="ml-auto h-7 w-36 rounded-md" />
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
