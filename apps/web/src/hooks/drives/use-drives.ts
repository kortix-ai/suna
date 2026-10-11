/**
 * The project's Files in the web app: the hooks live in `@kortix/sdk/react`
 * (use-project-files.ts). This module binds the signed-in user and keeps the
 * browser-only download helper.
 */

import { useAuth } from '@/features/providers/auth-provider';
import { downloadDriveFile } from '@kortix/sdk';
import { useProjectDrive as useProjectDriveFor } from '@kortix/sdk/react';

export {
  useDismissDriveConflict,
  useDriveAvailability,
  useDriveConflicts,
  useDriveFolder,
  useFolderAccess,
  useFolderPrincipals,
  useInvalidateDrives,
  useSessionDrives,
  useShareFolder,
  useUnshareFolder,
} from '@kortix/sdk/react';

/** The project's drive, and the signed-in user's own folder in it. */
export function useProjectDrive(projectId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useProjectDriveFor(projectId, user?.id, enabled);
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
