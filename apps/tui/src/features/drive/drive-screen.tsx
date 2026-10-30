/**
 * The Drive screen: the project's shared folders, the web's `/projects/:id/drive`.
 *
 * This file is the data half — every read is a `@kortix/sdk/react` hook, every
 * write is a standalone `@kortix/sdk` Drive function (there is no
 * `kortix().drives` namespace; the functions read the process-global config
 * `createKortix` installed), and the identity is the one `kortix()` client's
 * `validateToken`. It renders `<DriveView/>`, which owns pixels and keys and
 * knows nothing about the SDK.
 *
 * The page exists only with the project's `drives` flag on, which the web
 * derives from the Volumes switch in Feature flags
 * (`apps/web/src/app/[locale]/(app)/projects/[id]/drive/page.tsx`). Off, this
 * screen says so in one line and `o` opens that switch.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import {
  deleteDriveFile,
  makeDriveFolder,
  moveDriveFile,
  readDriveFile,
  uploadDriveFile,
} from '@kortix/sdk';
import {
  useDismissDriveConflict,
  useDriveAvailability,
  useDriveConflicts,
  useDriveFolder,
  useInvalidateDrives,
  useProjectDrive,
  useSessionDrives,
} from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { type ViewerState, blobToReadResult, formatBytes, toViewerState } from '../files/index.ts';
import {
  type DriveRow,
  baseName,
  buildPlaces,
  conflictRows,
  crumbText,
  driveWebUrl,
  entryRows,
  errorStatus,
  errorText,
  featureFlagsWebUrl,
  isUnder,
  joinDrivePath,
  locatePlace,
  moveTarget,
  normalizeDrivePath,
  parentDrivePath,
  placeRows,
  validName,
} from './drive-model.ts';
import { type DriveList, type DriveNotice, DriveView } from './drive-view.tsx';

export interface DriveScreenProps {
  projectId: string | null;
  /** The account the project belongs to. Carried for the caller's header. */
  accountId: string | null;
  /** The open session: its Drive mounts list under "This session". */
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin, for `o`. */
  webBaseUrl: string;
  onBack(): void;
  /** Reserved for a Drive row that names a session. No Drive read names one yet. */
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Test seam for `o`. Defaults to `lib/open-url.ts`. */
  openUrlImpl?: (url: string) => Promise<unknown>;
}

/** `uploadDriveFile` takes at most 64 MiB in one request. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Above this, Enter does not download a file to preview it. `readDriveFile`
 * fetches the whole file and the viewer paints 512 KiB of it at most.
 */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** How often the age column is recomputed. A minute is its smallest unit. */
const CLOCK_TICK_MS = 30_000;

/**
 * Who the token is. `useProjectDrive` is keyed and gated by the user id, and
 * the TUI's `ResolvedHost` carries none, so it is read once per process.
 */
const IDENTITY_KEY = ['tui', 'drive', 'identity'] as const;

/** `~/x` and relative paths → absolute, as a shell would read them. */
export function expandLocalPath(input: string, home = homedir(), cwd = process.cwd()): string {
  const value = input.trim();
  if (value === '~') return home;
  if (value.startsWith('~/')) return resolvePath(home, value.slice(2));
  return resolvePath(cwd, value);
}

export function DriveScreen({
  projectId,
  accountId: _accountId,
  sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession: _onOpenSession,
  onToast,
  openUrlImpl = openUrl,
}: DriveScreenProps) {
  const availability = useDriveAvailability(projectId ?? undefined);
  const identity = useQuery({
    queryKey: IDENTITY_KEY,
    queryFn: async () => {
      const result = await kortix().validateToken();
      if (!result.valid || !result.identity) throw result.error ?? new Error('Token rejected');
      return result.identity;
    },
    enabled: !!projectId && availability.enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const userId = identity.data?.user_id ?? null;
  const driveQuery = useProjectDrive(projectId ?? undefined, userId, availability.enabled);
  const drive = driveQuery.data ?? null;
  const driveId = drive?.driveId ?? null;

  /** `undefined`: not decided yet. `null`: Places. A string: that folder. */
  const [path, setPath] = useState<string | null | undefined>(undefined);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [showConflicts, setShowConflicts] = useState(false);
  const [cursorHint, setCursorHint] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'empty' });
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The path the preview waits on. A slower earlier read must not win. */
  const pendingRead = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Land where the web lands: My files, or Places when the caller has none.
  useEffect(() => {
    if (!drive || path !== undefined) return;
    setPath(drive.personalFolder ? normalizeDrivePath(drive.personalFolder) : null);
  }, [drive, path]);

  const invalidate = useInvalidateDrives();
  const dismiss = useDismissDriveConflict();
  const rootFolder = useDriveFolder(driveId, '/');
  const sessionDrives = useSessionDrives(projectId ?? undefined, sessionId ?? undefined);
  const list: DriveList = showConflicts ? 'conflicts' : path ? 'folder' : 'places';
  const folderPath = path ?? '/';
  // Off while Places or the conflicts are on screen: the hook polls every 10 s.
  const folder = useDriveFolder(list === 'folder' ? driveId : null, folderPath);
  const conflicts = useDriveConflicts(driveId, showConflicts);

  const places = useMemo(
    () =>
      drive
        ? buildPlaces({
            drive,
            rootEntries: rootFolder.data?.entries,
            sessionMounts: sessionDrives.data?.drives,
          })
        : [],
    [drive, rootFolder.data, sessionDrives.data],
  );

  const place = useMemo(() => {
    if (!path) return null;
    const picked = places.find((entry) => entry.id === placeId);
    if (picked && isUnder(path, picked.root)) return picked;
    return locatePlace(path, places);
  }, [path, placeId, places]);

  // A folder that is gone (deleted, moved) is not an error page: step up, as
  // the web does (`files-view.tsx` `missing`).
  const missing =
    list === 'folder' && folder.isError && errorStatus(folder.error) === 404 && folderPath !== '/';
  useEffect(() => {
    if (!missing || !path) return;
    setCursorHint(null);
    setPath(place && path === place.root ? null : parentDrivePath(path));
  }, [missing, path, place]);

  const rows = useMemo<DriveRow[]>(() => {
    if (list === 'places') return placeRows(places, rootFolder.isLoading);
    if (list === 'conflicts') return conflictRows(conflicts.data ?? [], now);
    return entryRows(folder.data?.entries ?? [], now);
  }, [list, places, rootFolder.isLoading, conflicts.data, folder.data, now]);

  const access = folder.data?.access ?? 'none';
  const canWrite = list === 'folder' && (access === 'write' || access === 'manage');
  const conflictCount = drive?.openConflicts ?? conflicts.data?.length ?? 0;

  const closeViewer = useCallback(() => {
    pendingRead.current = null;
    setViewer({ kind: 'empty' });
  }, []);

  const goTo = useCallback(
    (next: string | null, hint: string | null, nextPlaceId?: string | null) => {
      if (nextPlaceId !== undefined) setPlaceId(nextPlaceId);
      setShowConflicts(false);
      setCursorHint(hint);
      setPath(next);
    },
    [],
  );

  const preview = useCallback(
    (filePath: string) => {
      if (!driveId) return;
      const entry = folder.data?.entries.find((item) => normalizeDrivePath(item.path) === filePath);
      if (entry && entry.size > MAX_PREVIEW_BYTES) {
        setViewer({
          kind: 'error',
          path: filePath,
          message: `${formatBytes(entry.size)}. Too large to preview here. o opens the folder in the web app.`,
        });
        return;
      }
      pendingRead.current = filePath;
      setViewer({ kind: 'loading', path: filePath });
      void (async () => {
        try {
          const { blob } = await readDriveFile(driveId, filePath);
          const result = await blobToReadResult(blob);
          if (pendingRead.current !== filePath) return;
          setViewer(toViewerState(filePath, result));
        } catch (error) {
          if (pendingRead.current !== filePath) return;
          setViewer({ kind: 'error', path: filePath, message: errorText(error) });
        }
      })();
    },
    [driveId, folder.data],
  );

  const onOpen = useCallback(
    (row: DriveRow) => {
      if (row.kind === 'place') return goTo(row.path, null, row.id);
      if (row.kind === 'dir') return goTo(row.path, null);
      if (row.kind === 'file') return preview(row.path);
      if (row.kind === 'conflict') return goTo(parentDrivePath(row.path), row.path, null);
    },
    [goTo, preview],
  );

  const onParent = useCallback(() => {
    if (!path) return;
    if ((place && path === place.root) || path === '/') {
      closeViewer();
      return goTo(null, place?.id ?? null);
    }
    goTo(parentDrivePath(path), path);
  }, [path, place, goTo, closeViewer]);

  /** One write: busy line, the call, a refresh of every Drive query, a toast. */
  const run = useCallback(
    (label: string, work: () => Promise<string>) => {
      setBusy(label);
      void (async () => {
        try {
          const done = await work();
          await invalidate();
          onToast(done);
        } catch (error) {
          onToast(errorText(error), 'error');
        } finally {
          setBusy(null);
        }
      })();
    },
    [invalidate, onToast],
  );

  const onMakeFolder = useCallback(
    (input: string) => {
      const name = validName(input);
      if (!driveId || !name) return onToast('Type one folder name, without a slash.', 'error');
      const target = joinDrivePath(folderPath, name);
      setCursorHint(target);
      run('making folder…', async () => {
        await makeDriveFolder(driveId, target);
        return `Made folder ${name}.`;
      });
    },
    [driveId, folderPath, run, onToast],
  );

  const onMove = useCallback(
    (row: DriveRow, input: string) => {
      const to = driveId ? moveTarget(row.path, input) : null;
      if (!driveId || !to) return onToast('Type a new name, or a /path to move to.', 'error');
      setCursorHint(to);
      if (viewer.kind !== 'empty' && 'path' in viewer && viewer.path === row.path) closeViewer();
      run('moving…', async () => {
        await moveDriveFile(driveId, row.path, to);
        return `Moved ${row.name} to ${to}.`;
      });
    },
    [driveId, viewer, run, onToast, closeViewer],
  );

  const onDelete = useCallback(
    (row: DriveRow) => {
      if (!driveId) return;
      if (viewer.kind !== 'empty' && 'path' in viewer && isUnder(viewer.path, row.path)) closeViewer();
      run('deleting…', async () => {
        await deleteDriveFile(driveId, row.path, { recursive: row.kind === 'dir' });
        return `Deleted ${row.name}.`;
      });
    },
    [driveId, viewer, run, closeViewer],
  );

  const onUpload = useCallback(
    (input: string) => {
      if (!driveId) return;
      const local = expandLocalPath(input);
      run('uploading…', async () => {
        const info = await stat(local).catch(() => null);
        if (!info?.isFile()) throw new Error(`No file at ${local}.`);
        if (info.size > MAX_UPLOAD_BYTES) {
          throw new Error(`${formatBytes(info.size)} is above the 64 MiB limit. Upload it in the web app.`);
        }
        const name = baseName(local);
        const target = joinDrivePath(folderPath, name);
        setCursorHint(target);
        // `Bun.file` is a `Blob`; `uploadDriveFile` sends it as the request body.
        await uploadDriveFile(driveId, target, Bun.file(local));
        return `Uploaded ${name} (${formatBytes(info.size)}).`;
      });
    },
    [driveId, folderPath, run],
  );

  const notice = useMemo<DriveNotice | null>(() => {
    if (!projectId) return { tone: 'info', message: 'No project selected.', hint: 'Esc back' };
    if (availability.isLoading) return { tone: 'loading', message: 'checking Drive' };
    if (!availability.enabled) {
      return {
        tone: 'info',
        message: 'Drive is off for this project. Turn on Volumes in Feature flags.',
        hint: 'o open Feature flags in the web app · Esc back',
      };
    }
    if (identity.isError) {
      return {
        tone: 'error',
        message: `Could not read who you are: ${errorText(identity.error)}`,
        hint: 'r retry · Esc back',
      };
    }
    if (driveQuery.isError) {
      return {
        tone: 'error',
        message: `Could not load Drive: ${errorText(driveQuery.error)}`,
        hint: 'r retry · Esc back',
      };
    }
    if (!drive || path === undefined) return { tone: 'loading', message: 'loading Drive' };
    return null;
  }, [
    projectId,
    availability.isLoading,
    availability.enabled,
    identity.isError,
    identity.error,
    driveQuery.isError,
    driveQuery.error,
    drive,
    path,
  ]);

  const onOpenWeb = useCallback(
    (row: DriveRow | null) => {
      if (!projectId) return;
      let url: string;
      if (!availability.enabled) url = featureFlagsWebUrl(webBaseUrl, projectId);
      else {
        const target =
          row?.kind === 'place' || row?.kind === 'dir'
            ? row.path
            : row?.kind === 'file' || row?.kind === 'conflict'
              ? parentDrivePath(row.path)
              : list === 'folder'
                ? folderPath
                : (drive?.personalFolder ?? '/');
        url = driveWebUrl(webBaseUrl, projectId, target, drive?.personalFolder ?? null);
      }
      void openUrlImpl(url)
        .then(() => onToast(`Opened ${url}`))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [projectId, availability.enabled, webBaseUrl, list, folderPath, drive, openUrlImpl, onToast],
  );

  const onCopy = useCallback(
    (row: DriveRow | null) => {
      const text = row?.path || (list === 'folder' ? folderPath : '');
      if (!text) return onToast('Select a row first.', 'error');
      void copyToClipboard(text).then((result) => {
        if (result.ok) onToast(`Copied ${text}`);
        else onToast(`Copy failed: ${result.error ?? 'no clipboard tool'}`, 'error');
      });
    },
    [list, folderPath, onToast],
  );

  const onRefresh = useCallback(() => {
    setBusy('reloading…');
    void Promise.all([invalidate(), identity.isError ? identity.refetch() : null])
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [invalidate, identity, onToast]);

  const onDismissConflict = useCallback(
    (row: DriveRow) => {
      if (!driveId) return;
      void dismiss
        .mutateAsync({ driveId, conflictId: row.id })
        .then(() => onToast(`Dismissed the notice for ${baseName(row.path)}. The copy stays.`))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [driveId, dismiss, onToast],
  );

  const crumb = list === 'conflicts' ? 'Conflicts' : list === 'places' ? 'Places' : crumbText(place, folderPath);
  const loading =
    list === 'folder' ? folder.isLoading : list === 'conflicts' ? conflicts.isLoading : false;
  const listError =
    list === 'folder' && folder.isError && !missing
      ? errorText(folder.error)
      : list === 'conflicts' && conflicts.isError
        ? errorText(conflicts.error)
        : null;

  return (
    <DriveView
      focused={focused}
      width={width}
      height={height}
      notice={notice}
      list={list}
      crumb={crumb}
      rows={rows}
      loading={loading}
      errorMessage={listError}
      locationKey={`${list}:${folderPath}`}
      cursorHint={cursorHint}
      canWrite={canWrite}
      conflictCount={conflictCount}
      viewer={viewer}
      busyMessage={busy}
      onOpen={onOpen}
      onParent={onParent}
      onMakeFolder={onMakeFolder}
      onMove={onMove}
      onDelete={onDelete}
      onUpload={onUpload}
      onOpenWeb={onOpenWeb}
      onCopy={onCopy}
      onRefresh={onRefresh}
      onShowConflicts={(open) => {
        setCursorHint(null);
        setShowConflicts(open);
      }}
      onDismissConflict={onDismissConflict}
      onCloseViewer={closeViewer}
      onToast={onToast}
      onBack={onBack}
    />
  );
}
