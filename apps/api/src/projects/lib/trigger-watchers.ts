// Trigger watchers (KRTX-1742): who gets a trigger's failure and recovery
// alerts. STUB(KRTX-1742 WP-A): replaced by the automation work package.

export interface TriggerRef {
  accountId: string;
  projectId: string;
  slug: string;
}

/**
 * The users to alert for this trigger, already access-checked: unmuted
 * watcher rows plus the implicit `project_trigger_runtime.owner_user_id`;
 * when none of them may read the project's triggers (and no muted watcher
 * with access exists), the project managers.
 */
export async function resolveTriggerWatchers(_ref: TriggerRef): Promise<string[]> {
  return [];
}

/** The caller created or edited the trigger: follow it. Never un-mutes. */
export async function upsertTriggerWatcher(_ref: TriggerRef & { userId: string }): Promise<void> {}

/** The trigger was deleted: drop its watcher rows. */
export async function deleteTriggerWatchers(_ref: Omit<TriggerRef, 'accountId'>): Promise<void> {}
