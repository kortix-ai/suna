/**
 * A project's Files, reactive: the drive, its folders, sharing, conflicts and
 * what a session mounts. Every call goes through the REST functions in
 * `core/rest/projects-client/drives.ts`.
 *
 * Files change underneath the page: a running session writes into its mounted
 * folders and those writes land within seconds, so folder listings poll while
 * they are on screen. Every write invalidates the whole `qk.drives` scope: one
 * change can move a listing, the conflicts and the session mounts.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Drive,
  type DriveConflict,
  type DriveEntry,
  type FolderAccess,
  type FolderAccessView,
  type FolderLevel,
  type FolderPrincipalType,
  type FolderPrincipals,
  type SessionDrives,
  dismissDriveConflict,
  getFolderAccess,
  getProjectDrive,
  getSessionDrives,
  listDriveConflicts,
  listDriveFolder,
  listFolderPrincipals,
  shareFolder,
  unshareFolder,
} from '../core/rest/projects-client/drives';
import { qk } from './query-keys';
import { useFeatureFlag } from './use-feature-flag';

const LIVE_POLL_MS = 10_000;
/** Poll while the list loads fine; a failing list waits for a manual retry. */
const pollUnlessFailing = (interval: number) => (query: { state: { status: string } }) =>
  query.state.status === 'error' ? false : interval;

/** The project's drive and the caller's own folder in it: keyed by user, since it carries their access. */
export function projectDriveQueryOptions(projectId: string | undefined, userId: string | null | undefined, enabled = true) {
  return {
    queryKey: qk.drives.list(userId, { projectId }),
    queryFn: (): Promise<Drive> => getProjectDrive(projectId!),
    enabled: enabled && !!projectId && !!userId,
    staleTime: 15_000,
  };
}

/** One folder: what the caller may see in it, and their access to it. */
export function driveFolderQueryOptions(driveId: string | null, path: string) {
  return {
    queryKey: qk.drives.files(driveId ?? '', path),
    queryFn: (): Promise<{ entries: DriveEntry[]; access: FolderAccess }> => listDriveFolder(driveId!, path),
    enabled: !!driveId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS),
    staleTime: 2_000,
  };
}

/** Who has access to a folder: its own grants and the inherited ones. */
export function folderAccessQueryOptions(driveId: string | null, path: string, enabled = true) {
  return {
    queryKey: [...qk.drives.grants(driveId ?? ''), path] as const,
    queryFn: (): Promise<FolderAccessView> => getFolderAccess(driveId!, path),
    enabled: !!driveId && enabled,
  };
}

/** People, teams and agents a folder can be shared with. */
export function folderPrincipalsQueryOptions(driveId: string | null, enabled = true) {
  return {
    queryKey: [...qk.drives.drive(driveId ?? ''), 'principals'] as const,
    queryFn: (): Promise<FolderPrincipals> => listFolderPrincipals(driveId!),
    enabled: !!driveId && enabled,
    staleTime: 60_000,
  };
}

/** Conflict copies on the drive that are still open. */
export function driveConflictsQueryOptions(driveId: string | null, enabled = true) {
  return {
    queryKey: qk.drives.conflicts(driveId ?? ''),
    queryFn: (): Promise<DriveConflict[]> => listDriveConflicts(driveId!),
    enabled: !!driveId && enabled,
    refetchInterval: enabled ? pollUnlessFailing(LIVE_POLL_MS * 2) : (false as const),
  };
}

/** The folders a session mounts, and whether it is the caller's own session. */
export function sessionDrivesQueryOptions(
  projectId: string | undefined,
  sessionId: string | undefined,
  filesEnabled: boolean,
) {
  return {
    queryKey: qk.drives.session(projectId ?? '', sessionId ?? ''),
    queryFn: (): Promise<SessionDrives> => getSessionDrives(projectId!, sessionId!),
    enabled: filesEnabled && !!projectId && !!sessionId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS * 2),
    staleTime: 10_000,
  };
}

/** Files is a per-project feature (`drives`). Fail-closed while it loads. */
export function useDriveAvailability(projectId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  return { enabled: flag.enabled, isLoading: flag.isLoading };
}

export function useProjectDrive(projectId: string | undefined, userId: string | null | undefined, enabled = true) {
  return useQuery(projectDriveQueryOptions(projectId, userId, enabled));
}

export function useDriveFolder(driveId: string | null, path: string) {
  return useQuery(driveFolderQueryOptions(driveId, path));
}

export function useFolderAccess(driveId: string | null, path: string, enabled = true) {
  return useQuery(folderAccessQueryOptions(driveId, path, enabled));
}

export function useFolderPrincipals(driveId: string | null, enabled = true) {
  return useQuery(folderPrincipalsQueryOptions(driveId, enabled));
}

export function useSessionDrives(projectId: string | undefined, sessionId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  return useQuery(sessionDrivesQueryOptions(projectId, sessionId, flag.enabled));
}

export function useDriveConflicts(driveId: string | null, enabled = true) {
  return useQuery(driveConflictsQueryOptions(driveId, enabled));
}

/** Refresh every Files query (one write can move a listing, the conflicts and the session mounts). */
export function useInvalidateDrives() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.drives.scope() });
}

export function useShareFolder() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: {
      driveId: string;
      path: string;
      principalType: FolderPrincipalType;
      principalId?: string;
      level: FolderLevel;
    }) => shareFolder(input.driveId, input),
    onSettled: invalidate,
    // The caller reports the outcome itself; a change already applied is not retried.
    retry: false,
    onError: () => undefined,
  });
}

export function useUnshareFolder() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: { driveId: string; grantId: string }) => unshareFolder(input.driveId, input.grantId),
    onSettled: invalidate,
    // The caller reports the outcome itself; a change already applied is not retried.
    retry: false,
    onError: () => undefined,
  });
}

export function useDismissDriveConflict() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: { driveId: string; conflictId: string }) => {
      await dismissDriveConflict(input.driveId, input.conflictId);
    },
    onSettled: invalidate,
  });
}
