import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { syncProjectChannelBindings, type SyncResult } from './sync';

const SWEEP_BATCH_LIMIT = 200;

export interface SweepResult {
  scanned: number;
  inserted: number;
  updated: number;
  removed: number;
  failed: number;
  skipped: number;
}

export async function runChannelBindingSweep(): Promise<SweepResult> {
  const acc: SweepResult = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    failed: 0,
    skipped: 0,
  };

  const projectsForSweep = await db
    .select()
    .from(projects)
    .where(eq(projects.status, 'active'))
    .limit(SWEEP_BATCH_LIMIT);

  for (const project of projectsForSweep) {
    acc.scanned += 1;
    let result: SyncResult;
    try {
      result = await syncProjectChannelBindings(project);
    } catch (err) {
      acc.failed += 1;
      console.warn(
        '[channels] sync failed',
        project.projectId,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    acc.inserted += result.inserted;
    acc.updated += result.updated;
    acc.removed += result.removed;
    acc.skipped += result.skipped.length;
  }

  return acc;
}
