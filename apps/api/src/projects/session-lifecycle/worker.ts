import { config } from '../../config';
import { drainSessionLifecycleQueue } from './drain';

const state = globalThis as typeof globalThis & {
  __kortixLifecycleWorker?: ReturnType<typeof setInterval>;
  __kortixLifecycleDrainInFlight?: boolean;
};

/** Claims are CAS-protected; delivery runs on every API, independently of cron leadership. */
export function startSessionLifecycleWorker(): void {
  stopSessionLifecycleWorker();
  if (config.KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  // One drain per process at a time. A drain delivers prompts over the network
  // (~1.3 s each), so a 1 s interval without this guard stacked unbounded
  // concurrent drains on every API task under load and starved the DB pool:
  // unrelated routes hit the 55 s request deadline.
  const tick = () => {
    if (state.__kortixLifecycleDrainInFlight) return;
    state.__kortixLifecycleDrainInFlight = true;
    void drainSessionLifecycleQueue({ limit: 10 })
      .catch((error) => {
        console.error('[session-lifecycle] queue drain failed', error);
      })
      .finally(() => {
        state.__kortixLifecycleDrainInFlight = false;
      });
  };
  tick();
  state.__kortixLifecycleWorker = setInterval(tick, 1_000);
}

export function stopSessionLifecycleWorker(): void {
  if (state.__kortixLifecycleWorker) clearInterval(state.__kortixLifecycleWorker);
  state.__kortixLifecycleWorker = undefined;
}
