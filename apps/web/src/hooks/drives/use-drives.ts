/**
 * The project's Files: reads and writes, every call through `@kortix/sdk`.
 *
 * Files change underneath the page: a running session writes into its mounted
 * folders and those writes land here within seconds, so folder listings poll
 * while they are on screen. Every write invalidates the whole `qk.drives`
 * scope: one change can move a listing, the conflicts and the session mounts.
 */

import { useAuth } from '@/features/providers/auth-provider';
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
  downloadDriveFile,
  getFolderAccess,
  getProjectDrive,
  getSessionDrives,
  listDriveConflicts,
  listDriveFolder,
  listFolderPrincipals,
  shareFolder,
  unshareFolder,
} from '@kortix/sdk';
import { qk, useFeatureFlag } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const LIVE_POLL_MS = 10_000;
/** Poll while the list loads fine; a failing list waits for a manual retry. */
const pollUnlessFailing = (interval: number) => (query: { state: { status: string } }) =>
  query.state.status === 'error' ? false : interval;

/** Files is a per-project feature flag (`drives`). Fail-closed while it loads. */
export function useDriveAvailability(projectId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  return { enabled: flag.enabled, isLoading: flag.isLoading };
}

/** The project's drive, and the caller's own folder in it. */
export function useProjectDrive(projectId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    // Keyed by user: it carries the caller's own folder and access.
    queryKey: qk.drives.list(user?.id, { projectId }),
    queryFn: (): Promise<Drive> => getProjectDrive(projectId!),
    enabled: enabled && !!projectId && !!user?.id,
    staleTime: 15_000,
  });
}

/** One folder: what the caller may see in it, and their access to it. */
export function useDriveFolder(driveId: string | null, path: string) {
  return useQuery({
    queryKey: qk.drives.files(driveId ?? '', path),
    queryFn: (): Promise<{ entries: DriveEntry[]; access: FolderAccess }> => listDriveFolder(driveId!, path),
    enabled: !!driveId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS),
    staleTime: 2_000,
  });
}

/** Who has access to a folder (its own grants and the inherited ones). */
export function useFolderAccess(driveId: string | null, path: string, enabled = true) {
  return useQuery({
    queryKey: [...qk.drives.grants(driveId ?? ''), path],
    queryFn: (): Promise<FolderAccessView> => getFolderAccess(driveId!, path),
    enabled: !!driveId && enabled,
  });
}

export function useFolderPrincipals(driveId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...qk.drives.drive(driveId ?? ''), 'principals'],
    queryFn: (): Promise<FolderPrincipals> => listFolderPrincipals(driveId!),
    enabled: !!driveId && enabled,
    staleTime: 60_000,
  });
}

/** The folders a session mounts, and whether it is the caller's own session. */
export function useSessionDrives(projectId: string | undefined, sessionId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  return useQuery({
    queryKey: qk.drives.session(projectId ?? '', sessionId ?? ''),
    queryFn: (): Promise<SessionDrives> => getSessionDrives(projectId!, sessionId!),
    enabled: flag.enabled && !!projectId && !!sessionId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS * 2),
    staleTime: 10_000,
  });
}

export function useDriveConflicts(driveId: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.drives.conflicts(driveId ?? ''),
    queryFn: (): Promise<DriveConflict[]> => listDriveConflicts(driveId!),
    enabled: !!driveId && enabled,
    refetchInterval: enabled ? pollUnlessFailing(LIVE_POLL_MS * 2) : false,
  });
}

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
  });
}

export function useUnshareFolder() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: { driveId: string; grantId: string }) => unshareFolder(input.driveId, input.grantId),
    onSettled: invalidate,
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

/** Fetches one file with the caller's credentials and hands it to the browser. */
export async function saveDriveFile(driveId: string, path: string, name: string): Promise<void> {
  const blob: Blob = await downloadDriveFile(driveId, path);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next task: Safari cancels a download whose URL is revoked
    // in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
