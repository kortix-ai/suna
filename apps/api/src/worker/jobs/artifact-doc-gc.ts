import { gcArtifactDocs } from '../../artifacts/doc-gc';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';

const EVERY_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Leader-only (worker process): every 5 min, delete the live state of co-edited
 * docs nobody has used for 10 min whose updates are all in the file
 * (`artifacts/doc-gc.ts`). The next open seeds again from the file.
 */
export function startArtifactDocGc(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runWorkerTick('artifact-doc-gc', async () => {
      try {
        const { deleted } = await gcArtifactDocs();
        if (deleted.length > 0) logger.info('[artifact-doc-gc] deleted idle doc states', { count: deleted.length });
      } catch (error) {
        logger.warn('[artifact-doc-gc] tick failed', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }, EVERY_MS);
}

export function stopArtifactDocGc(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
