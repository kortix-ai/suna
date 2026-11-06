'use client';

import type { FeatureFlagKey } from '../core/rest/projects-client';
import { useProjectRow } from './use-project-row';

/**
 * Keys that graduated out of the flag system. Their features are on for every
 * project and the API no longer serves them, so the fail-closed read below
 * would hide a surface that is meant to be visible. Deprecated members of
 * `FeatureFlagKey`; removed with them in the next major.
 */
const GRADUATED_FEATURE_FLAG_KEYS: ReadonlySet<FeatureFlagKey> = new Set([
  'review_center',
  'agent_tunnel',
  'session_transcript_history',
  'teams',
  'config_releases',
  'apps',
  'llm_gateway',
  'pi_harness',
  'genui',
  'agentmail_email',
  'connectors_v2',
  'connectors_api_discover',
  'notification_center',
]);

/** What {@link useFeatureFlag} tells a caller about one flag. */
export interface FeatureFlagState {
  /** The server said EXACTLY `true` for this project. Never optimistic. */
  enabled: boolean;
  /** The project row has not answered yet. Treat as "not enabled". */
  isLoading: boolean;
}

/**
 * The ONE client-side gate for a per-project feature flag.
 *
 * Every flag-gated surface — a nav entry, a command-palette action, a page,
 * a Customize section — reads this hook, so they light up and go dark
 * together. Reads the shared bare project row (`qk.project.summary(id)`,
 * `GET /projects/:id`, one database read), never the git-backed detail, so a
 * flag-gated page renders without waiting on the repository.
 *
 * **Fail-closed by construction.** `enabled` is `=== true`, so a missing
 * project id, an in-flight query, an error, an older server that does not
 * serve the flag map, and a non-boolean wire value all resolve to `false`.
 * A disabled feature's surface must be invisible, not merely inert.
 *
 * The one exception is a graduated key (`review_center`, `agent_tunnel`,
 * `session_transcript_history`, `teams`, `config_releases`, `apps`,
 * `llm_gateway`, `pi_harness`, `genui`, `agentmail_email`, `connectors_v2`, `connectors_api_discover`,
 * `notification_center`): it reports `enabled: true` for every project, because the
 * feature no longer has an off state.
 */
export function useFeatureFlag(
  projectId: string | null | undefined,
  key: FeatureFlagKey,
): FeatureFlagState {
  const query = useProjectRow(projectId, { refetchOnWindowFocus: false });

  return {
    enabled:
      GRADUATED_FEATURE_FLAG_KEYS.has(key) || query.data?.experimental?.[key] === true,
    isLoading: query.isLoading,
  };
}
