/** The `event_triggers` project flag as the event-trigger code reads it. */
import { resolveFeatureFlag } from '../../feature-flags/registry';

/** Shown as the trigger's `error` while the project has the flag off. */
export const EVENT_TRIGGERS_OFF_MESSAGE =
  'App event triggers are off for this project. Turn them on in Settings → Feature flags.';

/** The project has the `event_triggers` flag on. */
export const eventTriggersEnabled = (projectMetadata: unknown): boolean =>
  resolveFeatureFlag(projectMetadata, 'event_triggers');

/** The project has the flag off: its event triggers stay unsubscribed. */
export const eventTriggersOffForProject = (projectMetadata: unknown): boolean =>
  !eventTriggersEnabled(projectMetadata);
