/**
 * The Drive operations memory uses, one object, so a unit test swaps in a
 * fake volume (`setVolumeOpsForTests`). The real one reads and writes the
 * project drive's Platinum volume and tells conflict scans about every write.
 */
import { noteDriveWrite } from '../drives/conflicts';
import { type DriveRow, readDriveVolume, writeDriveVolume } from '../drives/service';
import {
  DriveStorageError,
  driveStorageAvailable,
  listVolumeCommits,
  listVolumeFiles,
  readVolumeFile,
  removeVolumeFile,
  statVolumeFile,
  type VolumeCommit,
  type VolumeEntry,
  type VolumeFileStat,
  writeVolumeFile,
} from '../drives/volumes';

export interface FileRead {
  text: string;
  /** The version a conditional write names (`If-Match`). */
  etag: string | null;
}

/** The Drive operations memory uses, one object so a unit test swaps in a fake volume. */
export interface VolumeOps {
  /** Drive storage is configured. */
  available(): boolean;
  /** Every entry under `folder`, recursively; [] when the folder does not exist. */
  list(drive: DriveRow, folder: string): Promise<VolumeEntry[]>;
  /** The file (its first `headBytes` bytes when given), as of commit `at`; null when it does not exist. */
  read(drive: DriveRow, path: string, opts?: { at?: string; headBytes?: number }): Promise<FileRead | null>;
  stat(drive: DriveRow, path: string, at?: string): Promise<VolumeFileStat | null>;
  /** `overwrite: false` on an existing file, or a stale `ifMatch`, throws a 409 `DriveStorageError`. */
  write(drive: DriveRow, path: string, text: string, opts: { overwrite: boolean; ifMatch?: string }): Promise<void>;
  remove(drive: DriveRow, path: string): Promise<void>;
  /** The drive's newest commits, newest first. */
  commits(drive: DriveRow, limit: number): Promise<VolumeCommit[]>;
}

const missingAsNull = async <T>(run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DriveStorageError && error.status === 404) return null;
    throw error;
  }
};

const driveOps: VolumeOps = {
  available: driveStorageAvailable,
  list: async (drive, folder) =>
    (await missingAsNull(() => readDriveVolume(drive, (volume) => listVolumeFiles(volume, folder, true), () => []))) ?? [],
  read: (drive, path, opts) =>
    missingAsNull(() =>
      readDriveVolume(
        drive,
        async (volume) => {
          const res = await readVolumeFile(volume, path, opts?.headBytes ? `bytes=0-${opts.headBytes - 1}` : undefined, opts?.at);
          // 416: a range past the end of an empty file.
          const text = res.status === 416 ? '' : await res.text();
          return { text, etag: res.headers.get('etag') };
        },
        () => null,
      ),
    ),
  stat: (drive, path, at) => missingAsNull(() => readDriveVolume(drive, (volume) => statVolumeFile(volume, path, at), () => null)),
  write: async (drive, path, text, opts) => {
    await writeDriveVolume(drive, (volume) => writeVolumeFile(volume, path, new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>, opts));
    noteDriveWrite(drive.driveId);
  },
  remove: async (drive, path) => {
    await writeDriveVolume(drive, (volume) => removeVolumeFile(volume, path, false));
    noteDriveWrite(drive.driveId);
  },
  commits: (drive, limit) => readDriveVolume(drive, (volume) => listVolumeCommits(volume, limit), () => []),
};

let ops: VolumeOps = driveOps;
export const volumeOps = (): VolumeOps => ops;
/** Swap the storage for a test; `null` restores Drive. */
export function setVolumeOpsForTests(next: VolumeOps | null): void {
  ops = next ?? driveOps;
}
