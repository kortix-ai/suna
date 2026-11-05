import type { SessionDrive } from '@kortix/sdk';

/** What one mounted folder's open conflicts looked like at the last read. */
export interface ConflictMark {
  count: number;
  /** The newest open conflict's detection time seen so far (ISO 8601). */
  latestAt: string | null;
}

/** Per folder, keyed by drive and folder (`driveId:subdir`), never by position. */
export type ConflictMarks = Readonly<Record<string, ConflictMark>>;

const time = (at: string | null) => (at ? Date.parse(at) || 0 : 0);

const folderKey = (row: Pick<SessionDrive, 'driveId' | 'subdir'>) => `${row.driveId}:${row.subdir || '/'}`;

/**
 * How many of the session's open conflicts are new since the last read, and
 * the marks to compare the next read against.
 *
 * A folder the session has not seen before sets its mark and counts nothing:
 * its open conflicts were there before this session watched it. That covers
 * the first read, and the read where the sandbox mounts its folders (a new
 * session's first read comes before its sandbox mounts anything). A mark
 * outlives its folder's mount, so a folder that mounts again after a box
 * restart does not announce its old conflicts again.
 *
 * With `latestConflictAt` from the API, a conflict is new when it was detected
 * after the newest one already seen; without it (an API older than
 * 2026-11-04), when the folder's count rises.
 */
export function readConflictMarks(
  marks: ConflictMarks,
  drives: ReadonlyArray<Pick<SessionDrive, 'driveId' | 'subdir' | 'openConflicts' | 'latestConflictAt'>>,
): { marks: ConflictMarks; fresh: number } {
  const next: Record<string, ConflictMark> = { ...marks };
  let fresh = 0;
  for (const row of drives) {
    const key = folderKey(row);
    const count = row.openConflicts ?? 0;
    const latestAt = row.latestConflictAt ?? null;
    const seen = marks[key];
    if (seen) {
      if (row.latestConflictAt === undefined) {
        fresh += Math.max(0, count - seen.count);
      } else if (time(latestAt) > time(seen.latestAt)) {
        // Conflicts resolved since the last read lower the count, so the
        // difference can be 0 or less while one is new.
        fresh += Math.max(1, count - seen.count);
      }
    }
    next[key] = { count, latestAt: seen && time(seen.latestAt) > time(latestAt) ? seen.latestAt : latestAt };
  }
  return { marks: next, fresh };
}
