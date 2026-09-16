import { config } from '../../config';
import { drainSessionLifecycleQueue } from './engine';

const state = globalThis as typeof globalThis & {
  __kortixLifecycleWorker?: ReturnType<typeof setInterval>;
};

/** Claims are CAS-protected; delivery runs on every API, independently of cron leadership. */
export function startSessionLifecycleWorker(): void {
  stopSessionLifecycleWorker();
  if (config.KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  const tick = () => {
    void drainSessionLifecycleQueue({ limit: 10 }).catch((error) => {
      console.error('[session-lifecycle] queue drain failed', error);
    });
  };
  tick();
  state.__kortixLifecycleWorker = setInterval(tick, 1_000);
}

export function stopSessionLifecycleWorker(): void {
  if (state.__kortixLifecycleWorker) clearInterval(state.__kortixLifecycleWorker);
  state.__kortixLifecycleWorker = undefined;
}
