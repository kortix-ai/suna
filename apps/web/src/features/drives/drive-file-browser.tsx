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
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { getFileIcon } from '@/features/project-files/components/file-icon';
import {
  saveDriveFile,
  useDeleteDriveEntry,
  useDriveFiles,
  useMakeDriveFolder,
  useMoveDriveEntry,
  useUploadDriveFiles,
} from '@/hooks/drives/use-drives';
import { useFormatter, useLocale, useNow, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon,
  CloudArrowUpIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react';
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DRIVE_UPLOAD_LIMIT_BYTES,
  type DriveEntry,
  driveCrumbs,
  entryDate,
  formatBytes,
  joinDrivePath,
  parentDrivePath,
  sortEntries,
} from './drive-model';
import { DriveNameModal } from './drive-name-modal';

interface DriveFileBrowserProps {
  driveId: string;
  driveName: string;
  path: string;
  onNavigate: (path: string) => void;
  /** The pane's own controls (tabs, drive menu), at the end of the header row. */
  controls?: ReactNode;
  /** Drawn under the header row, e.g. a company drive's project grant. */
  banner?: ReactNode;
  /** One quiet line above the listing: counts, size, where sessions see it. */
  meta?: string;
  /** A drive shared with the viewer read-only: browse and download, no changes. */
  readOnly?: boolean;
}

type NameDialog = { mode: 'folder' } | { mode: 'rename'; entry: DriveEntry } | null;

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

export function DriveFileBrowser({
  driveId,
  driveName,
  path,
  onNavigate,
  controls,
  banner,
  meta,
  readOnly = false,
}: DriveFileBrowserProps) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const files = useDriveFiles(driveId, path);
  const upload = useUploadDriveFiles();
  const makeFolder = useMakeDriveFolder();
  const move = useMoveDriveEntry();
  const remove = useDeleteDriveEntry();

  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog>(null);
  const [pendingDelete, setPendingDelete] = useState<DriveEntry | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const entries = useMemo(() => sortEntries(files.data ?? []), [files.data]);
  const crumbs = driveCrumbs(path);
  const folderLabel = crumbs.at(-1)?.name ?? driveName;

  const startUpload = useCallback(
    (picked: File[]) => {
      if (picked.length === 0 || upload.isPending) return;
      const tooLarge = picked.find((file) => file.size > DRIVE_UPLOAD_LIMIT_BYTES);
      if (tooLarge) {
        errorToast(t('uploadTooLarge', { name: tooLarge.name }));
        return;
      }
      upload.mutate(
        { driveId, files: picked.map((file) => ({ file, path: joinDrivePath(path, file.name) })) },
        {
          onSuccess: (count) => successToast(t('uploaded', { count })),
          onError: (error) => errorToast(t('uploadFailed', { name: error.message })),
        },
      );
    },
    [driveId, path, t, upload],
  );

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    startUpload(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const dragHandlers = readOnly
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          // v1 uploads files only: a dropped folder arrives as a pseudo-file that
          // cannot be read, so skip every item the browser reports as a directory.
          const items = Array.from(event.dataTransfer.items ?? []);
          const dropped = items.length
            ? items
                .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null)
            : Array.from(event.dataTransfer.files);
          startUpload(dropped);
        },
      };

  const handleDownload = async (entry: DriveEntry) => {
    setDownloading(entry.path);
    try {
      await saveDriveFile(driveId, entry);
    } catch {
      errorToast(t('downloadFailed', { name: entry.name }));
    } finally {
      setDownloading(null);
    }
  };

  const submitName = (value: string) => {
    if (!nameDialog) return;
    if (nameDialog.mode === 'folder') {
      makeFolder.mutate(
        { driveId, path: joinDrivePath(path, value) },
        {
          onSuccess: () => {
            setNameDialog(null);
            successToast(t('folderCreated'));
          },
          onError: () => errorToast(t('folderFailed')),
        },
      );
      return;
    }
    const { entry } = nameDialog;
    move.mutate(
      { driveId, from: entry.path, to: joinDrivePath(parentDrivePath(entry.path), value) },
      {
        onSuccess: () => {
          setNameDialog(null);
          successToast(t('renamed'));
        },
        onError: () => errorToast(t('renameFailed')),
      },
    );
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    remove.mutate(
      { driveId, path: pendingDelete.path },
      {
        onSuccess: () => {
          setPendingDelete(null);
          successToast(t('deleted'));
        },
        onError: () => errorToast(t('deleteFailed')),
      },
    );
  };

  const openEntry = (entry: DriveEntry) => {
    if (entry.type === 'dir') onNavigate(entry.path);
    else void handleDownload(entry);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...dragHandlers}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <nav
          aria-label={t('breadcrumbs')}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onNavigate('/')}
            className={cn(
              'max-w-48 shrink-0 truncate text-sm',
              crumbs.length === 0 ? 'text-foreground font-medium' : 'text-muted-foreground',
            )}
          >
            {driveName}
          </Button>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-current={last ? 'page' : undefined}
                  onClick={() => onNavigate(crumb.path)}
                  className={cn(
                    'max-w-48 shrink-0 truncate text-sm',
                    last ? 'text-foreground font-medium' : 'text-muted-foreground',
                  )}
                >
                  {crumb.name}
                </Button>
              </span>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {readOnly ? (
            <span className="text-muted-foreground px-2 text-xs">{t('readOnly')}</span>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setNameDialog({ mode: 'folder' })}
                className="text-muted-foreground hover:text-foreground"
              >
                <FolderPlusIcon className="size-4 shrink-0" />
                <span className="hidden sm:inline">{t('newFolder')}</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={upload.isPending}
                onClick={() => inputRef.current?.click()}
              >
                {upload.isPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <UploadSimpleIcon className="size-4 shrink-0" />
                )}
                <span className="hidden sm:inline">{t('upload')}</span>
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                onChange={handleInput}
                aria-label={t('upload')}
              />
            </>
          )}
          {controls ? (
            <>
              <span aria-hidden className="bg-border mx-1 h-4 w-px" />
              {controls}
            </>
          ) : null}
        </div>
      </div>

      {banner}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {meta ? <p className="text-muted-foreground mb-3 truncate px-1 text-xs">{meta}</p> : null}
        {files.isLoading ? (
          <FileTableSkeleton />
        ) : files.isError ? (
          <ErrorState
            size="sm"
            title={t('filesLoadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => void files.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            size="sm"
            className="h-full"
            icon={crumbs.length === 0 ? CloudArrowUpIcon : FolderOpenIcon}
            title={crumbs.length === 0 ? t('emptyDriveTitle') : t('emptyFolderTitle')}
            description={readOnly ? undefined : t('emptyDriveDescription')}
            action={
              readOnly ? undefined : (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => inputRef.current?.click()}
                  disabled={upload.isPending}
                >
                  <UploadSimpleIcon className="size-4 shrink-0" />
                  {t('upload')}
                </Button>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columnName')}</TableHead>
                <TableHead className="hidden w-28 text-right sm:table-cell">
                  {t('columnSize')}
                </TableHead>
                <TableHead className="hidden w-40 md:table-cell">{t('columnModified')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const modified = entryDate(entry.mtime);
                const isDir = entry.type === 'dir';
                return (
                  <TableRow key={entry.path} className="group">
                    <TableCell className="max-w-0">
                      <button
                        type="button"
                        onClick={() => openEntry(entry)}
                        className="focus-visible:ring-ring flex w-full min-w-0 items-center gap-2.5 rounded-sm text-left outline-none focus-visible:ring-2"
                      >
                        {downloading === entry.path ? (
                          <Loading className="size-4 shrink-0" />
                        ) : (
                          getFileIcon(entry.name, {
                            isDirectory: isDir,
                            className: 'size-4 shrink-0',
                          })
                        )}
                        <span className="truncate text-sm">{entry.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-right text-xs tabular-nums sm:table-cell">
                      {isDir ? '' : formatBytes(entry.size, locale)}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                      {modified ? format.relativeTime(modified, now) : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('entryActions', { name: entry.name })}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <DotsThreeIcon className="size-4 shrink-0" weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isDir ? (
                            <DropdownMenuItem onSelect={() => onNavigate(entry.path)}>
                              <FolderOpenIcon className="size-4 shrink-0" />
                              {t('open')}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => void handleDownload(entry)}>
                              <DownloadSimpleIcon className="size-4 shrink-0" />
                              {t('download')}
                            </DropdownMenuItem>
                          )}
                          {readOnly ? null : (
                            <>
                              <DropdownMenuItem
                                onSelect={() => setNameDialog({ mode: 'rename', entry })}
                              >
                                <PencilSimpleIcon className="size-4 shrink-0" />
                                {t('rename')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setPendingDelete(entry)}
                              >
                                <TrashIcon className="size-4 shrink-0" />
                                {t('delete')}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {dragging ? (
        <div
          aria-hidden
          className="bg-background/90 border-ring pointer-events-none absolute inset-2 flex items-center justify-center rounded-md border border-dashed"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <CloudArrowUpIcon className="text-foreground size-8 shrink-0" />
            <p className="text-foreground text-sm font-medium">
              {t('dropToUpload', { folder: folderLabel })}
            </p>
          </div>
        </div>
      ) : null}

      <DriveNameModal
        open={nameDialog !== null}
        onOpenChange={(open) => (open ? undefined : setNameDialog(null))}
        title={nameDialog?.mode === 'rename' ? t('rename') : t('newFolder')}
        label={nameDialog?.mode === 'rename' ? t('newNameLabel') : t('folderNameLabel')}
        submitLabel={nameDialog?.mode === 'rename' ? t('save') : t('create')}
        initialValue={nameDialog?.mode === 'rename' ? nameDialog.entry.name : ''}
        validateAsEntry
        isPending={makeFolder.isPending || move.isPending}
        onSubmit={submitName}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
        title={t('deleteEntryTitle', { name: pendingDelete?.name ?? '' })}
        description={
          pendingDelete?.type === 'dir' ? t('deleteFolderDescription') : t('deleteFileDescription')
        }
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function FileTableSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}
