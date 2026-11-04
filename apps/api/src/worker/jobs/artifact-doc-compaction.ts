import { compactRequestedArtifactDocs } from '../../artifacts/doc-compaction';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';

const EVERY_MS = 15_000;
/** One tick's time budget: compaction steps stop starting after it. */
const BUDGET_MS = 2_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Leader-only (worker process): every 15 s, compact the live docs a push
 * marked as past the row threshold (`artifacts/doc-compaction.ts`), one small
 * window at a time, for at most 2 s of steps. Web replicas never compact.
 */
export function startArtifactDocCompaction(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runWorkerTick('artifact-doc-compaction', async () => {
      try {
        const { compacted, steps } = await compactRequestedArtifactDocs({ budgetMs: BUDGET_MS });
        if (steps > 0) logger.info('[artifact-doc-compaction] compacted', { docs: compacted.length, steps });
      } catch (error) {
        logger.warn('[artifact-doc-compaction] tick failed', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }, EVERY_MS);
}

export function stopArtifactDocCompaction(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
