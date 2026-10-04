/**
 * Kortix Drive reads and writes — every call goes through `@kortix/sdk`.
 *
 * Drives change underneath the page: a running session writes into its
 * mounted drives and those writes land here within seconds, so the file and
 * version lists poll while they are on screen. Every write invalidates the
 * whole `qk.drives` scope: one mutation can move a drive's size, its file
 * list, its version history and the session mounts at once.
 */

import {
  type DriveAccess,
  type DriveConflictRecord,
  type DriveEntry,
  type DriveGrantRecord,
  type DriveRecord,
  type DriveVersion,
  listOf,
  type SessionDriveMount,
} from '@/features/drives/drive-model';
import { useAuth } from '@/features/providers/auth-provider';
import {
  attachSessionDrive,
  createDrive,
  deleteDrive,
  deleteDriveFile,
  detachSessionDrive,
  dismissDriveConflict,
  downloadDriveFile,
  type DriveGrantSubject,
  getProjectDetail,
  getSessionDrives,
  grantDrive,
  listDriveConflicts,
  listDriveFiles,
  listDriveGrants,
  listDrives,
  listDriveVersions,
  makeDriveFolder,
  moveDriveFile,
  removeDriveGrant,
  renameDrive,
  restoreDriveVersion,
  revokeDrive,
  setSessionDriveAccess,
  uploadDriveFile,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const LIVE_POLL_MS = 10_000;
/** Poll while the list loads fine; a failing list waits for a manual retry. */
const pollUnlessFailing = (interval: number) => (query: { state: { status: string } }) =>
  query.state.status === 'error' ? false : interval;

/**
 * Drive is a per-project feature flag. Fail-closed: `enabled` is false until
 * the project detail resolves. `accountId` is the project's account, where
 * drives created from this project belong.
 */
export function useDriveAvailability(projectId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  const project = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  return {
    enabled: flag.enabled,
    isLoading: flag.isLoading,
    accountId: project.data?.project?.account_id ?? null,
  };
}

export function useDrives(projectId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    // Keyed by user: the list holds the caller's own personal drives.
    queryKey: qk.drives.list(user?.id, { projectId }),
    queryFn: async (): Promise<DriveRecord[]> =>
      listOf<DriveRecord>(await listDrives({ projectId }), 'drives'),
    enabled: enabled && !!projectId && !!user?.id,
    staleTime: 15_000,
  });
}

export function useDriveFiles(driveId: string | null, path: string) {
  return useQuery({
    queryKey: qk.drives.files(driveId ?? '', path),
    queryFn: async (): Promise<DriveEntry[]> =>
      listOf<DriveEntry>(await listDriveFiles(driveId!, path), 'entries'),
    enabled: !!driveId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS),
    staleTime: 2_000,
  });
}

export function useDriveVersions(driveId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.drives.versions(driveId ?? ''),
    queryFn: async (): Promise<DriveVersion[]> =>
      listOf<DriveVersion>(await listDriveVersions(driveId!), 'versions'),
    enabled: !!driveId && enabled,
    refetchInterval: enabled ? pollUnlessFailing(LIVE_POLL_MS * 3) : false,
  });
}

/**
 * The drives a session mounts, and whether it is the caller's own session.
 * Polls while the session is open: a drive can be attached from elsewhere, and
 * a conflict on a mounted drive should reach the chip without a reload.
 */
export function useSessionDrives(projectId: string | undefined, sessionId: string | undefined) {
  const flag = useFeatureFlag(projectId, 'drives');
  return useQuery({
    queryKey: qk.drives.session(projectId ?? '', sessionId ?? ''),
    queryFn: async (): Promise<{
      drives: SessionDriveMount[];
      personal: boolean;
      skipped: Array<{ driveId: string; name: string }>;
    }> => {
      const result = await getSessionDrives(projectId!, sessionId!);
      return {
        drives: listOf<SessionDriveMount>(result as never, 'drives'),
        personal: !!result?.personal,
        skipped: result?.skipped ?? [],
      };
    },
    enabled: flag.enabled && !!projectId && !!sessionId,
    refetchInterval: pollUnlessFailing(LIVE_POLL_MS * 2),
    staleTime: 10_000,
  });
}

export function useDriveGrants(driveId: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.drives.grants(driveId ?? ''),
    queryFn: async (): Promise<DriveGrantRecord[]> =>
      listOf<DriveGrantRecord>(await listDriveGrants(driveId!), 'grants'),
    enabled: !!driveId && enabled,
  });
}

export function useDriveConflicts(driveId: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.drives.conflicts(driveId ?? ''),
    queryFn: async (): Promise<DriveConflictRecord[]> =>
      listOf<DriveConflictRecord>(await listDriveConflicts(driveId!), 'conflicts'),
    enabled: !!driveId && enabled,
    refetchInterval: enabled ? pollUnlessFailing(LIVE_POLL_MS * 2) : false,
  });
}

function useInvalidateDrives() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.drives.scope() });
}

export function useCreateDrive() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: {
      name: string;
      kind: 'personal' | 'company';
      accountId?: string;
    }): Promise<DriveRecord> => createDrive(input),
    onSettled: invalidate,
  });
}

export function useRenameDrive() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: { driveId: string; name: string }): Promise<DriveRecord> =>
      renameDrive(input.driveId, input.name),
    onSettled: invalidate,
  });
}

export function useDeleteDrive() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (driveId: string) => {
      await deleteDrive(driveId);
    },
    onSettled: invalidate,
  });
}

/** A company drive's grant to one project (null access removes it). */
export function useSetDriveGrant() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: {
      driveId: string;
      projectId: string;
      access: DriveAccess | null;
    }) => {
      const subject: DriveGrantSubject = { type: 'project', projectId: input.projectId };
      if (input.access) await grantDrive(input.driveId, subject, input.access);
      else await revokeDrive(input.driveId, subject);
    },
    onSettled: invalidate,
  });
}

/** Grant a drive to any subject (project, person, agent), or remove that grant (null access). */
export function useSetDriveSubjectGrant() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: {
      driveId: string;
      subject: DriveGrantSubject;
      access: DriveAccess | null;
    }) => {
      if (input.access) await grantDrive(input.driveId, input.subject, input.access);
      else await revokeDrive(input.driveId, input.subject);
    },
    onSettled: invalidate,
  });
}

export function useRemoveDriveGrant() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: { driveId: string; grantId: string }) => {
      await removeDriveGrant(input.driveId, input.grantId);
    },
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

/** Attach, detach or switch the access of one drive in a running (or stopped) session. */
export function useChangeSessionDrive(projectId: string, sessionId: string) {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (
      change:
        | { type: 'attach'; driveId: string; readOnly?: boolean }
        | { type: 'detach'; driveId: string }
        | { type: 'access'; driveId: string; access: DriveAccess },
    ) => {
      if (change.type === 'attach') {
        return attachSessionDrive(projectId, sessionId, {
          driveId: change.driveId,
          readOnly: change.readOnly,
        });
      }
      if (change.type === 'detach') return detachSessionDrive(projectId, sessionId, change.driveId);
      return setSessionDriveAccess(projectId, sessionId, change.driveId, change.access);
    },
    onSettled: invalidate,
  });
}

export function useUploadDriveFiles() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    // Sequential on purpose: one drive, one writer, and a failure names the
    // file it stopped at instead of leaving a half-finished parallel batch.
    mutationFn: async (input: { driveId: string; files: { path: string; file: File }[] }) => {
      let uploaded = 0;
      for (const item of input.files) {
        try {
          await uploadDriveFile(input.driveId, item.path, item.file);
        } catch (error) {
          throw Object.assign(new Error(item.file.name), { cause: error, uploaded });
        }
        uploaded += 1;
      }
      return uploaded;
    },
    onSettled: invalidate,
  });
}

export function useMakeDriveFolder() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: { driveId: string; path: string }) => {
      await makeDriveFolder(input.driveId, input.path);
    },
    onSettled: invalidate,
  });
}

export function useMoveDriveEntry() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: { driveId: string; from: string; to: string }) => {
      await moveDriveFile(input.driveId, input.from, input.to);
    },
    onSettled: invalidate,
  });
}

export function useDeleteDriveEntry() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: async (input: { driveId: string; path: string }) => {
      await deleteDriveFile(input.driveId, input.path, { recursive: true });
    },
    onSettled: invalidate,
  });
}

export function useRestoreDriveVersion() {
  const invalidate = useInvalidateDrives();
  return useMutation({
    mutationFn: (input: { driveId: string; versionId: string }): Promise<DriveRecord> =>
      restoreDriveVersion(input.driveId, input.versionId),
    onSettled: invalidate,
  });
}

/** Fetches one file with the caller's credentials and hands it to the browser. */
export async function saveDriveFile(driveId: string, entry: DriveEntry): Promise<void> {
  const blob: Blob = await downloadDriveFile(driveId, entry.path);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = entry.name;
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
