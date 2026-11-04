/**
 * The GC of co-edited doc states (KRTX-3670, contract v2): "nobody connected:
 * no Yjs state; the next open builds it from the file". The worker job
 * `worker/jobs/artifact-doc-gc.ts` runs this tick every 5 min.
 *
 * A state goes when ALL of these hold:
 *   - nothing changed it for `DOC_GC_IDLE_MS` (no push, flush or lease call);
 *   - its lease is free, or ended `DOC_GC_IDLE_MS` ago or more;
 *   - every update is in the file (`flushed_seq` >= the newest seq).
 * Only state rows are deleted: each one's update rows (of its own epoch), root
 * index and clients go with it by foreign key, so the GC can never reach the
 * rows of an epoch it did not select and lock. Batched and bounded per
 * tick; a state another transaction holds (a push, a lease call) is skipped
 * (`FOR UPDATE SKIP LOCKED`), never waited on. A client that still holds the
 * old epoch sees `seeded:false` or a new epoch and rebuilds from the file.
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { DOC_GC_IDLE_MS } from './doc-rules';

export async function gcArtifactDocs(options: { batchSize?: number; maxBatches?: number } = {}): Promise<{ deleted: string[] }> {
  const batchSize = options.batchSize ?? 50;
  const maxBatches = options.maxBatches ?? 20;
  const idleSeconds = DOC_GC_IDLE_MS / 1000;
  const deleted: string[] = [];
  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = await db.transaction(async (tx) => {
      const gone = await tx.execute(sql`
        with idle as (
          select artifact_id
            from kortix.artifact_doc_state
           where updated_at <= now() - make_interval(secs => ${idleSeconds})
             and (lease_holder is null or lease_expires_at <= now() - make_interval(secs => ${idleSeconds}))
             and flushed_seq >= next_seq - 1
           order by updated_at
           limit ${batchSize}
             for update skip locked
        )
        delete from kortix.artifact_doc_state s
         using idle
         where s.artifact_id = idle.artifact_id
        returning s.artifact_id::text as artifact_id`);
      // Their update rows, roots and clients go by cascade (`artifact_doc_updates_epoch_fk`).
      return (gone as unknown as Array<{ artifact_id: string }>).map((row) => row.artifact_id);
    });
    deleted.push(...ids);
    if (ids.length < batchSize) break;
  }
  return { deleted };
}
