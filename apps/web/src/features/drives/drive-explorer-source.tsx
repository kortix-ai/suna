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
import { attachmentMime } from '@/features/session/attachment-mime';
import { useInvalidateDrives, saveDriveFile } from '@/hooks/drives/use-drives';
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
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const DriveFilesContext = createContext<{ driveId: string } | null>(null);

export function DriveFilesProvider({ driveId, children }: { driveId: string; children: ReactNode }) {
  const value = useMemo(() => ({ driveId }), [driveId]);
  return <DriveFilesContext.Provider value={value}>{children}</DriveFilesContext.Provider>;
}

function useDriveId(): string {
  const ctx = useContext(DriveFilesContext);
  if (!ctx) throw new Error('DriveFilesProvider is missing');
  return ctx.driveId;
}

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
  const driveId = useDriveId();
  const path = toDrivePath(dirPath);
  const query = useQuery({
    queryKey: qk.drives.files(driveId, path),
    queryFn: () => listDriveFolder(driveId, path),
    refetchInterval: (q) => (q.state.status === 'error' ? false : 10_000),
    staleTime: 2_000,
  });
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

const TEXT_LIMIT = 2 * 1024 * 1024;

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
      const type = attachmentMime(blob.type === 'application/octet-stream' ? '' : blob.type, filePath ?? '');
      return { blob: type === blob.type ? blob : new Blob([blob], { type }), version };
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
    void (async () => {
      const bytes = new Uint8Array(await b.slice(0, TEXT_LIMIT + 1).arrayBuffer());
      let text: string | null = null;
      if (bytes.length <= TEXT_LIMIT) {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          text = null;
        }
      }
      if (cancelled) return;
      if (text !== null) {
        setData({ type: 'text', content: text });
        return;
      }
      const all = new Uint8Array(await b.arrayBuffer());
      let binary = '';
      for (let i = 0; i < all.length; i += 0x8000) binary += String.fromCharCode(...all.subarray(i, i + 0x8000));
      if (!cancelled) setData({ type: 'binary', content: btoa(binary), encoding: 'base64', mimeType: b.type || undefined });
    })();
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

function useDriveMutation<TArgs>(run: (driveId: string, args: TArgs) => Promise<unknown>) {
  const driveId = useDriveId();
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (args: TArgs) => run(driveId, args),
    onSettled: invalidate,
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
  capabilities: { write: true, search: false, hiddenToggle: false, gitStatusChip: false },
  useFileViewerSource: useDriveFileViewerSource,
  useFileList: useDriveFileList,
  // Files has no compute behind it to park.
  useReadinessParked: () => false,
  useGitStatus: () => ({ data: undefined }),
  useFileEventInvalidation: () => undefined,
  useFileSearch: () => ({ data: undefined, isLoading: false, error: null }),
  useFileHistory: () => idle(),
  useFileCommitDiff: () => idle(),
  useFileUpload: () =>
    useDriveMutation<{ file: File | Blob; targetPath?: string }>((driveId, { file, targetPath }) => {
      const name = (file as File).name || 'file';
      const dir = toDrivePath(targetPath);
      return uploadDriveFile(driveId, `${dir === '/' ? '' : dir}/${name}`, file);
    }),
  useFileDelete: () =>
    useDriveMutation<{ filePath: string }>((driveId, { filePath }) =>
      deleteDriveFile(driveId, toDrivePath(filePath), { recursive: true }),
    ),
  useFileMkdir: () => useDriveMutation<{ dirPath: string }>((driveId, { dirPath }) => makeDriveFolder(driveId, toDrivePath(dirPath))),
  useFileRename: () =>
    useDriveMutation<{ from: string; to: string }>((driveId, { from, to }) =>
      moveDriveFile(driveId, toDrivePath(from), toDrivePath(to)),
    ),
  useFileCreate: () =>
    useDriveMutation<{ filePath: string }>((driveId, { filePath }) =>
      uploadDriveFile(driveId, toDrivePath(filePath), new Uint8Array() as Uint8Array<ArrayBuffer>),
    ),
  useFileCopy: () =>
    useDriveMutation<{ sourcePath: string; destPath: string }>(async (driveId, { sourcePath, destPath }) => {
      const blob = await downloadDriveFile(driveId, toDrivePath(sourcePath));
      return uploadDriveFile(driveId, toDrivePath(destPath), blob);
    }),
  useDirectoryDownload: () => ({ downloadDir: () => undefined, isDownloading: () => false }),
  useDownloadFile: () => {
    const driveId = useDriveId();
    return (filePath: string, fileName?: string) =>
      saveDriveFile(driveId, toDrivePath(filePath), fileName ?? toDrivePath(filePath).split('/').pop() ?? 'file');
  },
};

export { parentOf as parentDrivePath };
