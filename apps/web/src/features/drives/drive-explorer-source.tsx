'use client';

/**
 * The project's Files in the shared Drive-style explorer (`<DriveExplorer>`):
 * the same browser, preview, upload, rename and delete as the Repo view, over
 * the project drive instead of a git ref. Every hook reads the drive id from
 * `<DriveFilesProvider>`, so the hook functions stay module constants.
 *
 * Paths: the explorer works in drive paths without a leading slash
 * (`Users/ana/notes.md`); the API takes them with one.
 */

import type { FileNode } from '@/features/file-browser/types';
import type { FileContentResult, FileSource } from '@/features/file-viewer';
import type { ExplorerQueryResult, FileExplorerSource } from '@/features/project-files/explorer-source';
import { saveDriveFile } from '@/hooks/drives/use-drives';
import { blobToFileContent, typedDriveBlob } from './session-drive-files';
import {
  deleteDriveFile,
  downloadDriveFile,
  listDriveFolder,
  makeDriveFolder,
  moveDriveFile,
  readDriveFile,
  uploadDriveFile,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { ScopedCache } from '@/lib/storage/managed-storage';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const DriveFilesContext = createContext<{ driveId: string; userId?: string } | null>(null);

/** `userId` turns on the saved listings below; they are kept per person. */
export function DriveFilesProvider({
  driveId,
  userId,
  children,
}: {
  driveId: string;
  userId?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ driveId, userId }), [driveId, userId]);
  return <DriveFilesContext.Provider value={value}>{children}</DriveFilesContext.Provider>;
}

function useDriveFilesContext() {
  const ctx = useContext(DriveFilesContext);
  if (!ctx) throw new Error('DriveFilesProvider is missing');
  return ctx;
}

function useDriveId(): string {
  return useDriveFilesContext().driveId;
}

type FolderListing = Awaited<ReturnType<typeof listDriveFolder>>;

/**
 * The last listing of each folder a person opened, kept across reloads so
 * Drive and every folder's item count paint at once; the request still runs
 * and replaces it. Scoped `user:drive:path`, so one person never sees
 * another's. ScopedCache keeps the 300 most recent and gives way under quota.
 */
const folderCache = new ScopedCache<FolderListing>('kortix_drive_folder', 300);
/** ponytail: a huge folder is not saved; page it in if those need to paint instantly too. */
const MAX_CACHED_ENTRIES = 1_000;

/** `Users/ana` or `/Users/ana/` -> `/Users/ana`; the root is `/`. */
export function toDrivePath(p: string | null | undefined): string {
  const trimmed = (p ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

const fromDrivePath = (p: string) => p.replace(/^\/+/, '');

const idle = <T,>(): ExplorerQueryResult<T> => ({
  data: undefined,
  isLoading: false,
  error: null,
  refetch: async () => undefined,
});

function useDriveFileList(dirPath: string): ExplorerQueryResult<FileNode[]> {
  const { driveId, userId } = useDriveFilesContext();
  const path = toDrivePath(dirPath);
  const scope = userId ? `${userId}:${driveId}:${path}` : null;
  const query = useQuery({
    queryKey: qk.drives.files(driveId, path),
    queryFn: () => listDriveFolder(driveId, path),
    refetchInterval: (q) => (q.state.status === 'error' ? false : 10_000),
    staleTime: 2_000,
    // The saved listing paints first; updatedAt 0 marks it stale, so the
    // request still runs on mount.
    initialData: () => (scope ? folderCache.get(scope) : undefined),
    initialDataUpdatedAt: 0,
  });
  useEffect(() => {
    if (!scope || !query.data || query.dataUpdatedAt === 0) return;
    if (query.data.entries.length <= MAX_CACHED_ENTRIES) folderCache.set(scope, query.data);
  }, [scope, query.data, query.dataUpdatedAt]);
  const data = useMemo<FileNode[] | undefined>(
    () =>
      query.data?.entries
        .filter((e) => e.type !== 'symlink')
        .map((e) => ({
          name: e.name,
          path: fromDrivePath(e.path),
          absolute: e.path,
          type: e.type === 'dir' ? 'directory' : 'file',
          ignored: false,
        })),
    [query.data],
  );
  return { data, isLoading: query.isLoading, isFetching: query.isFetching, error: query.error, refetch: query.refetch };
}

const blobKey = (driveId: string, filePath: string) => [...qk.drives.drive(driveId), 'blob', filePath] as const;

/**
 * A file's bytes, read through the drive API (never a session's sandbox), with
 * the version they are. The type comes from the name: the API serves every
 * file as octet-stream, and the previewers pick on it (images, PDF).
 */
function useDriveBlob(filePath: string | null) {
  const driveId = useDriveId();
  return useQuery({
    queryKey: blobKey(driveId, filePath ?? ''),
    queryFn: async ({ signal }) => {
      const { blob, version } = await readDriveFile(driveId, toDrivePath(filePath), signal);
      return { blob: typedDriveBlob(blob, filePath ?? ''), version };
    },
    enabled: !!filePath,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Save an edit over `filePath`, conditional on the version the viewer read: a
 * file someone changed since is refused (409 `file_changed`), never clobbered.
 */
async function saveDriveEdit(queryClient: QueryClient, driveId: string, filePath: string, file: File) {
  const read = queryClient.getQueryData<{ blob: Blob; version: string | null }>(blobKey(driveId, filePath));
  await uploadDriveFile(driveId, toDrivePath(filePath), file, { ifMatch: read?.version ?? null });
  await queryClient.invalidateQueries({ queryKey: blobKey(driveId, filePath) });
}

function useDriveFileContent(filePath: string | null): FileContentResult {
  const blob = useDriveBlob(filePath);
  const [data, setData] = useState<FileContentResult['data']>(undefined);
  useEffect(() => {
    let cancelled = false;
    const b = blob.data?.blob;
    if (!b) {
      setData(undefined);
      return;
    }
    void blobToFileContent(b).then((content) => {
      if (!cancelled) setData(content);
    });
    return () => {
      cancelled = true;
    };
  }, [blob.data]);
  return {
    data,
    isLoading: blob.isLoading || (!!blob.data && !data),
    error: blob.error,
    refetch: blob.refetch,
    dataUpdatedAt: blob.dataUpdatedAt,
  };
}

function useDriveBinaryBlob(filePath: string | null) {
  const blob = useDriveBlob(filePath);
  const [url, setUrl] = useState<string | null>(null);
  const bytes = blob.data?.blob ?? null;
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(bytes);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return {
    blobUrl: url,
    blob: bytes,
    isLoading: blob.isLoading,
    error: blob.error ? (blob.error instanceof Error ? blob.error.message : String(blob.error)) : null,
  };
}

function useDriveUpload(driveId: string) {
  return async (file: File | Blob, targetPath?: string) => {
    const name = (file as File).name || 'file';
    const dir = toDrivePath(targetPath);
    return uploadDriveFile(driveId, `${dir === '/' ? '' : dir}/${name}`, file);
  };
}

function useDriveFileViewerSource(): FileSource {
  const driveId = useDriveId();
  const upload = useDriveUpload(driveId);
  const queryClient = useQueryClient();
  return useMemo<FileSource>(
    () => ({
      id: 'project-drive',
      bytesOnly: true,
      useFileContent: useDriveFileContent,
      useBinaryBlob: useDriveBinaryBlob,
      download: (filePath, fileName) => saveDriveFile(driveId, toDrivePath(filePath), fileName),
      upload: (file, targetPath) => upload(file, targetPath),
      save: (filePath, file) => saveDriveEdit(queryClient, driveId, filePath, file),
    }),
    [driveId, upload, queryClient],
  );
}

/**
 * A drive write, followed by a refetch of ONLY the folders it changed
 * (`touched`, drive paths). Each folder card in view is a live listing query,
 * so refetching the whole drive scope after every file of a 12-file upload
 * sent 12 × (every card + the root + access + conflicts) requests, and
 * re-downloaded every thumbnail. Version history is marked stale (it refetches
 * only if it is open).
 */
function useDriveMutation<TArgs>(
  run: (driveId: string, args: TArgs) => Promise<unknown>,
  touched: (args: TArgs) => string[],
) {
  const driveId = useDriveId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => run(driveId, args),
    onSettled: (_data, _error, args) =>
      Promise.all([
        ...[...new Set(touched(args))].map((folder) =>
          queryClient.invalidateQueries({ queryKey: qk.drives.files(driveId, folder), exact: true }),
        ),
        queryClient.invalidateQueries({ queryKey: qk.drives.versions(driveId), refetchType: 'none' }),
      ]),
    // A create, move or delete is not idempotent: retrying one the server
    // already applied answers "already exists" / "not found" for a success.
    retry: false,
    // Every explorer call site toasts its own outcome; the app-wide fallback
    // toast would add a second, generic one.
    onError: () => undefined,
  });
}

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

export const driveExplorerSource: FileExplorerSource = {
  capabilities: {
    write: true,
    search: false,
    hiddenToggle: false,
    gitStatusChip: false,
    newFile: false,
    // The top level and `/Users` hold only folders; files go inside one.
    filesAllowedAt: (path) => {
      const p = toDrivePath(path);
      return p !== '/' && p !== '/Users';
    },
  },
  useFileViewerSource: useDriveFileViewerSource,
  useFileList: useDriveFileList,
  // Files has no compute behind it to park.
  useReadinessParked: () => false,
  useGitStatus: () => ({ data: undefined }),
  useFileEventInvalidation: () => undefined,
  useFileSearch: () => ({ data: undefined, isLoading: false, error: null }),
  useFileHistory: () => idle(),
  useFileCommitDiff: () => idle(),
  useFileUpload: () => {
    const queryClient = useQueryClient();
    return useDriveMutation<{
      file: File | Blob;
      targetPath?: string;
      onProgress?: (sentBytes: number, totalBytes: number) => void;
    }>(
      async (driveId, { file, targetPath, onProgress }) => {
      const name = (file as File).name || 'file';
      const dir = toDrivePath(targetPath);
      const path = `${dir === '/' ? '' : dir}/${name}`;
      const key = blobKey(driveId, fromDrivePath(path));
      const local = typedDriveBlob(file, name);
      try {
        const result = await uploadDriveFile(driveId, path, file, { onProgress });
        queryClient.setQueryData(key, { blob: local, version: result.version ?? null });
        return result;
      } catch (err) {
        queryClient.removeQueries({ queryKey: key, exact: true });
        throw err;
      }
      },
      ({ targetPath }) => [toDrivePath(targetPath)],
    );
  },
  useUploadPreview: () => {
    const driveId = useDriveId();
    const queryClient = useQueryClient();
    // The local bytes are the file's preview while it goes up, so its
    // thumbnail paints at once and never asks the server for a file that is
    // not there yet (a 404 showed "File not found" until the upload landed).
    // ponytail: held fresh for 10 min; a slower upload refetches and may 404 once.
    return useCallback(
      (file: File, targetPath?: string) => {
        const dir = toDrivePath(targetPath);
        const path = `${dir === '/' ? '' : dir}/${file.name}`;
        queryClient.setQueryData(
          blobKey(driveId, fromDrivePath(path)),
          { blob: typedDriveBlob(file, file.name), version: null },
          { updatedAt: Date.now() + 10 * 60_000 },
        );
      },
      [driveId, queryClient],
    );
  },
  useFileDelete: () =>
    useDriveMutation<{ filePath: string }>(
      (driveId, { filePath }) => deleteDriveFile(driveId, toDrivePath(filePath), { recursive: true }),
      ({ filePath }) => [parentOf(toDrivePath(filePath))],
    ),
  useFileMkdir: () =>
    useDriveMutation<{ dirPath: string }>(
      (driveId, { dirPath }) => makeDriveFolder(driveId, toDrivePath(dirPath)),
      ({ dirPath }) => [parentOf(toDrivePath(dirPath))],
    ),
  useFileRename: () =>
    useDriveMutation<{ from: string; to: string }>(
      (driveId, { from, to }) => moveDriveFile(driveId, toDrivePath(from), toDrivePath(to)),
      ({ from, to }) => [parentOf(toDrivePath(from)), parentOf(toDrivePath(to))],
    ),
  useFileCreate: () =>
    useDriveMutation<{ filePath: string }>(
      (driveId, { filePath }) =>
        uploadDriveFile(driveId, toDrivePath(filePath), new Uint8Array() as Uint8Array<ArrayBuffer>),
      ({ filePath }) => [parentOf(toDrivePath(filePath))],
    ),
  useFileCopy: () =>
    useDriveMutation<{ sourcePath: string; destPath: string }>(
      async (driveId, { sourcePath, destPath }) => {
        const blob = await downloadDriveFile(driveId, toDrivePath(sourcePath));
        return uploadDriveFile(driveId, toDrivePath(destPath), blob);
      },
      ({ destPath }) => [parentOf(toDrivePath(destPath))],
    ),
  useDirectoryDownload: () => ({ downloadDir: () => undefined, isDownloading: () => false }),
  useDownloadFile: () => {
    const driveId = useDriveId();
    return (filePath: string, fileName?: string) =>
      saveDriveFile(driveId, toDrivePath(filePath), fileName ?? toDrivePath(filePath).split('/').pop() ?? 'file');
  },
};

export { parentOf as parentDrivePath };
