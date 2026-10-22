// A channel's folders in the project's Files (`spaceDriveFolders`): made when
// the channel is made, moved when it is renamed. Best effort: a failure is
// logged and never fails the channel request.

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { and, eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { noteDriveWrite } from './conflicts';
import { ensureProjectDrive, findProjectDrive, moveDriveFolder, refreshDriveNotes, sessionDrivesEnabled, writeDriveVolume } from './service';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { DriveStorageError, driveStorageAvailable, writeVolumeFile } from './volumes';

/** A new channel's folder and its Memory folder; the Files tab makes them on open when this fails. */
export async function makeChannelFolders(accountId: string, projectId: string, slug: string): Promise<void> {
  try {
    if (!driveStorageAvailable() || !(await projectFeatureFlagEnabled(projectId, 'drives'))) return;
    const drive = await ensureProjectDrive(accountId, projectId);
    const { memory } = spaceDriveFolders('channel', slug, null)!;
    // The marker inside Memory makes both folders; one that exists answers 409.
    await writeDriveVolume(drive, (volume) =>
      writeVolumeFile(volume, `${memory}/.keep`, new Uint8Array(), { overwrite: false }),
    ).catch((err) => {
      if (!(err instanceof DriveStorageError && err.status === 409)) throw err;
    });
    noteDriveWrite(drive.driveId);
  } catch (err) {
    logger.warn(`[drives] the folders of channel #${slug} in project ${projectId} were not made`, {
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
  void refreshChannelThreadNotes(projectId, spaceId);
}

/** Threads whose notes a channel rename rewrites at once. */
const NOTES_REFRESH_CONCURRENCY = 4;

/** Rewrite /drives/README.md in every thread of the channel that has a running box; best effort. */
async function refreshChannelThreadNotes(projectId: string, spaceId: string): Promise<void> {
  try {
    if (!(await sessionDrivesEnabled(projectId))) return;
    const rows = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, projectSessions.sessionId))
      .where(and(eq(projectSessions.spaceId, spaceId), eq(sessionSandboxes.status, 'active')));
    // Each refresh is a sandbox exec with an ownership pass over every writable mount.
    await mapWithConcurrency(rows, NOTES_REFRESH_CONCURRENCY, ({ sessionId }) => refreshDriveNotes(sessionId));
  } catch (err) {
    logger.warn(`[drives] the notes of channel ${spaceId}'s threads were not refreshed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
