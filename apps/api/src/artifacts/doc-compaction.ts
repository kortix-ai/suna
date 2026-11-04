/**
 * Compaction of co-edited doc Artifacts, on the worker (KRTX-3670). A push
 * past the row threshold only marks its doc (`compaction_requested_at`); this
 * tick compacts the marked docs one small window at a time
 * (`compactArtifactDoc`: at most 256 KiB and 50,000 structs per step) until
 * each is below the threshold or the tick's time budget is spent. It yields to
 * the event loop between steps. A doc in its compaction back-off waits.
 */
import { and, asc, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { artifactDocState } from '@kortix/db';
import { db } from '../shared/db';
import { DOC_COMPACTION_BACKOFF_MS } from './doc-rules';
import { compactArtifactDoc } from './doc-service';

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function compactRequestedArtifactDocs(
  options: { budgetMs?: number; maxDocs?: number } = {},
): Promise<{ compacted: string[]; steps: number }> {
  const budgetMs = options.budgetMs ?? 2_000;
  const started = performance.now();
  const due = await db.select({ artifactId: artifactDocState.artifactId }).from(artifactDocState)
    .where(and(
      isNotNull(artifactDocState.compactionRequestedAt),
      or(
        isNull(artifactDocState.compactionFailedAt),
        lte(artifactDocState.compactionFailedAt, sql`now() - make_interval(secs => ${DOC_COMPACTION_BACKOFF_MS / 1000})`),
      ),
    ))
    .orderBy(asc(artifactDocState.compactionRequestedAt))
    .limit(options.maxDocs ?? 20);
  const compacted: string[] = [];
  let steps = 0;
  for (const { artifactId } of due) {
    for (;;) {
      if (steps > 0 && performance.now() - started >= budgetMs) return { compacted, steps };
      const step = await compactArtifactDoc(artifactId);
      steps += 1;
      if (step.done) {
        if (!compacted.includes(artifactId)) compacted.push(artifactId);
        await yieldToEventLoop();
        continue;
      }
      // below_threshold: the step cleared the mark of the epoch it read. busy, backoff, failed, too_large,
      // stale (a reset or the GC replaced the state mid-step): the mark stays; a back-off keeps it out of the next ticks.
      break;
    }
  }
  return { compacted, steps };
}
