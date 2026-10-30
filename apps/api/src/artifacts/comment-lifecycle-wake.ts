import { config } from '../config';
import { logger } from '../lib/logger';

export interface ArtifactCommentLifecycleReceipt {
  idempotencyKey: string;
  availableAt: Date;
}

interface Dependencies {
  workersEnabled: () => boolean;
  jobWorkerEnabled: () => boolean;
  now: () => number;
  schedule: (run: () => void, delay: number) => void;
  drain: (input: { idempotencyKey: string; limit: 1; burst: false; coalesce: false }) => Promise<unknown>;
  onError: (key: string) => void;
}

const MAX_WAKE_DELAY_MS = 60_000;

export function createArtifactCommentLifecycleWaker(deps: Dependencies) {
  const enabled = () => deps.workersEnabled() || deps.jobWorkerEnabled();
  const waiting = new Set<string>();
  const running = new Set<string>();
  return (receipt: ArtifactCommentLifecycleReceipt): void => {
    if (!enabled()) return;
    const delay = receipt.availableAt.getTime() - deps.now();
    if (!Number.isFinite(delay) || delay > MAX_WAKE_DELAY_MS) return;
    const run = () => {
      waiting.delete(receipt.idempotencyKey);
      if (!enabled() || running.has(receipt.idempotencyKey)) return;
      running.add(receipt.idempotencyKey);
      void Promise.resolve().then(() => deps.drain({
        idempotencyKey: receipt.idempotencyKey, limit: 1, burst: false, coalesce: false,
      })).catch(() => deps.onError(receipt.idempotencyKey)).finally(() => {
        running.delete(receipt.idempotencyKey);
      });
    };
    if (delay <= 0) run();
    else if (!waiting.has(receipt.idempotencyKey)) {
      waiting.add(receipt.idempotencyKey);
      try { deps.schedule(run, delay); }
      catch {
        waiting.delete(receipt.idempotencyKey);
        deps.onError(receipt.idempotencyKey);
      }
    }
  };
}

export const wakeArtifactCommentLifecycle = createArtifactCommentLifecycleWaker({
  workersEnabled: () => config.KORTIX_WORKERS_ENABLED,
  jobWorkerEnabled: () => config.KORTIX_JOB_WORKER_ENABLED,
  now: Date.now,
  schedule: (run, delay) => { setTimeout(run, delay).unref(); },
  drain: async (input) => {
    const { drainSessionLifecycleQueue } = await import('../projects/surface');
    return drainSessionLifecycleQueue(input);
  },
  onError: (idempotencyKey) => {
    logger.warn('[artifact-comments] targeted lifecycle wake failed; command remains queued', { idempotencyKey });
  },
});
