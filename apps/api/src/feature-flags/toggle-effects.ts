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
 * they call are themselves idempotent and re-run on their periodic sweeps.
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { reconcileChannelConnectors, reconcileComputerConnectors } from '../connectors/sync';

export interface FeatureFlagToggleContext {
  key: FeatureFlagKey;
  projectId: string;
  accountId: string;
  /** The project's metadata AFTER the write. */
  metadata: unknown;
}

type ToggleEffect = (ctx: FeatureFlagToggleContext) => Promise<void>;

const reconcileProjectChannels: ToggleEffect = async ({ projectId }) => {
  await reconcileChannelConnectors(projectId);
};

/**
 * Effects by flag. Channel-backed flags (voice, teams, agentmail_email) all
 * re-run channel-connector materialization so the connector row appears or
 * disappears with the flag instead of waiting for the next periodic sweep.
 */
const TOGGLE_EFFECTS: Partial<Record<FeatureFlagKey, ToggleEffect>> = {
  // Kept for parity with the historical route behavior: the computer connector
  // is deliberately NOT flag-gated (see registry header), but a toggle still
  // re-syncs account connectors so any UI-adjacent drift converges promptly.
  agent_tunnel: async ({ accountId }) => {
    await reconcileComputerConnectors(accountId);
  },
  voice: reconcileProjectChannels,
  teams: reconcileProjectChannels,
  agentmail_email: reconcileProjectChannels,
};

/**
 * Run the toggle effect for a flag, if any. Never throws; one retry, then an
 * error-level log that names the flag and project so a failed convergence is
 * findable instead of a silent console.warn.
 */
export async function runFeatureFlagToggleEffects(ctx: FeatureFlagToggleContext): Promise<void> {
  const effect = TOGGLE_EFFECTS[ctx.key];
  if (!effect) return;
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
          'state converges on the next periodic reconcile',
        second instanceof Error ? second.message : second,
        first instanceof Error ? `(first attempt: ${first.message})` : '',
      );
    }
  }
}

/** Exported for tests: which flags have registered effects. */
export const FEATURE_FLAGS_WITH_TOGGLE_EFFECTS = Object.keys(TOGGLE_EFFECTS) as FeatureFlagKey[];
