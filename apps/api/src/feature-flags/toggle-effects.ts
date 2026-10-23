/**
 * Per-flag side effects that run after a project's override changes.
 *
 * Kept out of ./registry so the registry stays pure (config only, no DB, no
 * connector/sandbox imports — those modules themselves read flag state, and a
 * registry that imported them would create cycles). The PATCH route calls
 * {@link runFeatureFlagToggleEffects} after the write commits.
 *
 * Contract: effects are convergence work, not part of the toggle's success —
 * the API response does not wait for them. Every effect is retried once and
 * failures are logged at error level with the flag + project; the reconcilers
 * they call are themselves idempotent. The connector and event-subscription
 * ones re-run on their periodic sweeps. The `project_channels` backfill re-runs
 * only from the call that creates `#general` (`ensureDefaultSpace`: a channel
 * list, a session create or a warm claim): a failure after `#general` exists is
 * not retried until the flag is toggled again.
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { reconcileChannelConnectors } from '../connectors/sync';
import { refreshRunningThreadNotes } from '../drives/space-folders';
import {
  reconcileEventSubscriptionsFromCatalog,
  recordChannelsReenabled,
  releaseProjectEventSubscriptions,
  retireWarmProjectSessions,
  turnOnChannels,
} from '../projects/surface';
import { resolveFeatureFlag } from './registry';

export interface FeatureFlagToggleContext {
  key: FeatureFlagKey;
  projectId: string;
  accountId: string;
  /** The project's metadata AFTER the write. */
  metadata: unknown;
  /** The project's metadata BEFORE the write, read in the write's transaction; absent = unknown. */
  previousMetadata?: unknown;
  /** The write's DB time (`projects.updated_at`, ms). Absent: not a flag write, never "turned on again". */
  writtenAt?: Date;
}

type ToggleEffect = (ctx: FeatureFlagToggleContext) => Promise<void>;

const reconcileProjectChannels: ToggleEffect = async ({ projectId }) => {
  await reconcileChannelConnectors(projectId);
};

/**
 * Effects by flag. The channel-backed flag (agentmail_email) re-runs
 * channel-connector materialization so the connector row appears or
 * disappears with the flag instead of waiting for the next periodic sweep.
 */
const TOGGLE_EFFECTS: Partial<Record<FeatureFlagKey, ToggleEffect>> = {
  agentmail_email: reconcileProjectChannels,
  // Also the Kortix event source: off, its triggers report the legacy "no app-event source" text and
  // their poll streams are dropped; on, they subscribe without a re-save.
  connectors_v2: async (ctx) => {
    await reconcileProjectChannels(ctx);
    if (resolveFeatureFlag(ctx.metadata, 'event_triggers')) await reconcileEventSubscriptionsFromCatalog(ctx.projectId, ctx.accountId);
  },
  // Off: drop every provider instance so no delivery outlives the switch.
  // On: existing triggers go live without a re-save.
  event_triggers: async ({ projectId, accountId, metadata }) => {
    if (resolveFeatureFlag(metadata, 'event_triggers')) await reconcileEventSubscriptionsFromCatalog(projectId, accountId);
    else await releaseProjectEventSubscriptions(projectId);
  },
  // On: create `#general` and file every session that has no space into it. Off: nothing is deleted.
  // On again (off before the write, `#general` older than the write): mark the intro seen for the
  // project's members (D8: no intro on turn-on again) and record the `#general` line with the count.
  // A `#general` made after the write (a channel list in the window before this effect) is a first on.
  // Both: running threads' /drives/README.md gains or drops its channel section (that never throws).
  project_channels: async ({ projectId, accountId, metadata, previousMetadata, writtenAt }) => {
    if (resolveFeatureFlag(metadata, 'project_channels')) {
      const { generalCreatedAt, filed } = await turnOnChannels(projectId, accountId);
      if (writtenAt && generalCreatedAt < writtenAt && !resolveFeatureFlag(previousMetadata, 'project_channels')) {
        await recordChannelsReenabled({ accountId, projectId }, filed, writtenAt);
      }
    }
    await refreshRunningThreadNotes(projectId);
  },
};

/**
 * Run the toggle effect for a flag, if any. Never throws; one retry, then an
 * error-level log that names the flag and project so a failed convergence is
 * findable instead of a silent console.warn.
 */
export function runFeatureFlagToggleEffects(ctx: FeatureFlagToggleContext): Promise<void> {
  const run = runWithRetry(ctx).finally(() => inflight.delete(run));
  inflight.add(run);
  return run;
}

// replica-local: the effects this process started; tests await them (toggleEffectsSettled).
const inflight = new Set<Promise<void>>();

/** Resolves when every toggle effect this process started has finished. */
export async function toggleEffectsSettled(): Promise<void> {
  await Promise.all([...inflight]);
}

async function runWithRetry(ctx: FeatureFlagToggleContext): Promise<void> {
  // Every flag reaches the box as boot-only env (KORTIX_FEATURE_FLAGS, KORTIX_GENUI): a warm box
  // from before the change must not be adopted, or its skills and CLI keep the old flag.
  const own = TOGGLE_EFFECTS[ctx.key];
  const effect: ToggleEffect = async (c) => {
    await retireWarmProjectSessions(c.projectId);
    if (own) await own(c);
  };
  try {
    await effect(ctx);
    return;
  } catch (first) {
    try {
      await effect(ctx);
      return;
    } catch (second) {
      console.error(
        `[feature-flags] toggle effect failed twice for '${ctx.key}' on project ${ctx.projectId}; ` +
          'not retried here: connectors and event subscriptions converge on their periodic sweeps; project_channels converges only if #general did not exist yet (the call that creates it files unassigned sessions), else on the next toggle',
        second instanceof Error ? second.message : second,
        first instanceof Error ? `(first attempt: ${first.message})` : '',
      );
    }
  }
}
