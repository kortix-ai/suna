import { config } from '../lib/config';
import { runWorkerTick } from '../services/audit/audit-scope';
import {
  globalForProjectTriggers,
  runProjectTriggerSchedulerTick,
  triggerSchedulerIntervalMs,
  type TriggerSchedulerTimer,
} from '../services/projects';

export let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;

export function startProjectTriggerScheduler(): void {
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  // Everything the tick starts (sweep, drains, connector reconcile) inherits
  // the worker context through AsyncLocalStorage.
  const tick = () => void runWorkerTick('trigger-scheduler', runProjectTriggerSchedulerTick);
  tick();
  triggerSchedulerTimer = setInterval(tick, triggerSchedulerIntervalMs());
  globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = triggerSchedulerTimer;
}

export function stopProjectTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
    globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = null;
  }
}
