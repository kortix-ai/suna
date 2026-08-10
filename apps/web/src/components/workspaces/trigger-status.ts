/**
 * Row badge state for a trigger in the schedules / webhooks list.
 *
 * The list badge shows what the trigger IS (active / paused), not the action
 * you can take on it — the action lives on the detail sheet button. Getting
 * these two backwards makes an active trigger read as a stopped one.
 */
export type TriggerBadgeState = {
  status: 'active' | 'paused';
  icon: 'clock' | 'webhook' | 'pause';
  className: string;
  label: string;
};

export function triggerBadgeState(enabled: boolean, type: 'cron' | 'webhook'): TriggerBadgeState {
  if (!enabled) {
    return {
      status: 'paused',
      icon: 'pause',
      className: 'bg-muted text-muted-foreground',
      label: 'Paused',
    };
  }
  return {
    status: 'active',
    icon: type === 'cron' ? 'clock' : 'webhook',
    className: 'bg-kortix-green/10 text-kortix-green',
    label: 'Active',
  };
}
