// A space's folders in the project's Files (`spaceDriveFolders`): a channel's
// made when the channel is made (`#general` when it is created), moved when it
// is renamed; a DM's made when it is opened. Best effort: a failure is logged
// and never fails the request.

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { and, eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { noteDriveWrite } from './conflicts';
import {
  type DriveRow,
  ensurePersonalFolder,
  ensureProjectDrive,
  findProjectDrive,
  moveDriveFolder,
  refreshDriveNotes,
  sessionDrivesEnabled,
  writeDriveVolume,
} from './service';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { DriveStorageError, driveStorageAvailable, writeVolumeFile } from './volumes';

/** The project's drive when Drive is on, made on first use; else null. */
async function driveWhenOn(accountId: string, projectId: string): Promise<DriveRow | null> {
  if (!driveStorageAvailable() || !(await projectFeatureFlagEnabled(projectId, 'drives'))) return null;
  return ensureProjectDrive(accountId, projectId);
}

/** Make each folder (and its parents) with the empty `.keep` marker the Files list hides; one that exists answers 409. */
async function makeFolders(drive: DriveRow, folders: readonly string[]): Promise<void> {
  await writeDriveVolume(drive, async (volume) => {
    for (const folder of folders) {
      await writeVolumeFile(volume, `${folder}/.keep`, new Uint8Array(), { overwrite: false }).catch((err) => {
        if (!(err instanceof DriveStorageError && err.status === 409)) throw err;
      });
    }
  });
  noteDriveWrite(drive.driveId);
}

/**
 * A new channel's folder and its empty `Memory` folder (the channel's memory
 * layer); the Files tab makes the folder on open when this fails.
 */
export async function makeChannelFolders(accountId: string, projectId: string, slug: string): Promise<void> {
  try {
    const drive = await driveWhenOn(accountId, projectId);
    const folders = spaceDriveFolders('channel', slug, null)!;
    if (drive) await makeFolders(drive, [folders.files, folders.memory]);
  } catch (err) {
    logger.warn(`[drives] the folders of channel #${slug} in project ${projectId} were not made`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A DM's files folder `<personal>/Agents/<agent>` and its agent memory folder
 * `<personal>/Memory/<agent>`, in the member's own folder (made first when they
 * have none). Nothing for an agent name that is not one plain path segment.
 * Idempotent, so every open of the DM may call it.
 */
export async function makeDmFolders(accountId: string, projectId: string, userId: string, agentName: string): Promise<void> {
  try {
    const drive = await driveWhenOn(accountId, projectId);
    if (!drive) return;
    const folders = spaceDriveFolders('dm', agentName, await ensurePersonalFolder(drive, userId));
    if (folders) await makeFolders(drive, [folders.files, folders.memory]);
  } catch (err) {
    logger.warn(`[drives] the folders of a DM with ${agentName} in project ${projectId} were not made`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A renamed channel's folder follows its new slug, through the Drive move
 * route's own path (sharing and session mounts follow). Not gated on the
 * `drives` flag: a rename while Drive is off still moves the folder, so Drive
 * turned back on finds it. A channel that never had a folder moves nothing.
 * Then the channel's running threads get notes that name the new path, off
 * the response path: their mounts did not change, so nothing else rewrites them.
 */
export async function moveChannelFolder(projectId: string, spaceId: string, fromSlug: string, toSlug: string): Promise<void> {
  try {
    const drive = driveStorageAvailable() ? await findProjectDrive(projectId) : null;
    if (drive) {
      const from = spaceDriveFolders('channel', fromSlug, null)!.files;
      const to = spaceDriveFolders('channel', toSlug, null)!.files;
      await moveDriveFolder(drive, from, to, () => undefined);
      noteDriveWrite(drive.driveId);
    }
  } catch (err) {
    if (!(err instanceof DriveStorageError && err.status === 404)) {
      logger.warn(`[drives] the folder of channel #${fromSlug} in project ${projectId} did not move to #${toSlug}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  void refreshRunningThreadNotes(projectId, spaceId);
}

/** Threads whose notes one refresh rewrites at once. */
const NOTES_REFRESH_CONCURRENCY = 4;

/** The project's threads that have a running box; only the space's when `spaceId` is given. */
export async function runningThreadIds(projectId: string, spaceId?: string): Promise<string[]> {
  const rows = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, projectSessions.sessionId))
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        spaceId ? eq(projectSessions.spaceId, spaceId) : undefined,
        eq(sessionSandboxes.status, 'active'),
      ),
    );
  return rows.map((r) => r.sessionId);
}

/**
 * Rewrite /drives/README.md in every running thread of the project (of one
 * space when `spaceId` is given): a channel rename, or the Channels switch,
 * which adds or drops the channel section. Best effort; never throws.
 */
export async function refreshRunningThreadNotes(projectId: string, spaceId?: string): Promise<void> {
  try {
    if (!(await sessionDrivesEnabled(projectId))) return;
    // Each refresh is a sandbox exec with an ownership pass over every writable mount.
    await mapWithConcurrency(await runningThreadIds(projectId, spaceId), NOTES_REFRESH_CONCURRENCY, refreshDriveNotes);
  } catch (err) {
    logger.warn(`[drives] the notes of project ${projectId}'s running threads were not refreshed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
