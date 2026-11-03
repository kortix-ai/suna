// A write through the API makes its drive due for the indexer's next pass,
// so a file saved in Files is searchable within one pass (~20 s) instead of
// waiting for the drive's turn in the rotation.

import { logger } from '../../lib/logger';
import { markIndexDue } from './store';

// replica-local: when this process last made a drive due, so a burst of
// writes costs one UPDATE per drive per DUE_DEBOUNCE_MS. Another replica
// makes its own writes due the same way.
const dueNoted = new Map<string, number>();
const DUE_DEBOUNCE_MS = 10_000;

export function noteDriveIndexDue(driveId: string): void {
  const now = Date.now();
  if ((dueNoted.get(driveId) ?? 0) > now - DUE_DEBOUNCE_MS) return;
  dueNoted.set(driveId, now);
  if (dueNoted.size > 5_000) {
    for (const [id, at] of dueNoted) if (at < now - DUE_DEBOUNCE_MS) dueNoted.delete(id);
  }
  markIndexDue(driveId).catch((err) =>
    logger.warn(`[drive-index] marking drive ${driveId} due failed:`, { error: err instanceof Error ? err.message : String(err) }),
  );
}
