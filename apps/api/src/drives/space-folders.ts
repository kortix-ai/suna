// A channel's folders in the project's Files (`spaceDriveFolders`): made when
// the channel is made, moved when it is renamed. Best effort: a failure is
// logged and never fails the channel request.

import { spaceDriveFolders } from '@kortix/shared';
import { logger } from '../lib/logger';
import { noteDriveWrite } from './conflicts';
import { ensureProjectDrive, findProjectDrive, moveDriveFolder, writeDriveVolume } from './service';
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
 */
export async function moveChannelFolder(projectId: string, fromSlug: string, toSlug: string): Promise<void> {
  try {
    const drive = driveStorageAvailable() ? await findProjectDrive(projectId) : null;
    if (!drive) return;
    const from = spaceDriveFolders('channel', fromSlug, null)!.files;
    const to = spaceDriveFolders('channel', toSlug, null)!.files;
    await moveDriveFolder(drive, from, to, () => undefined);
    noteDriveWrite(drive.driveId);
  } catch (err) {
    if (err instanceof DriveStorageError && err.status === 404) return;
    logger.warn(`[drives] the folder of channel #${fromSlug} in project ${projectId} did not move to #${toSlug}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
