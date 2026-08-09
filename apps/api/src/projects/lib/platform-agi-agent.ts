import {
  AGI_AGENT_NAME,
  AGI_SANDBOX_SLUG,
} from '@kortix/shared';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import {
  PLATFORM_AGI_AGENT_ACTIONS,
  platformAgiAgentGrant,
} from '../../iam/agi-agent-policy';
import type { ProjectConfigSummary } from '../git/types';

export { platformAgiAgentGrant } from '../../iam/agi-agent-policy';

/** Per-project opt-in for the platform coordinator (Settings → Feature flags). */
export function projectAgiEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'agi');
}

/** Enable the platform coordinator for an explicit trusted goal push. */
export function platformAgiAgentEnabledForSession(
  projectMetadata: unknown,
  requestedAgent: string | null,
  trustedGoalPush: boolean,
): boolean {
  return (
    projectAgiEnabled(projectMetadata) ||
    (requestedAgent === AGI_AGENT_NAME && trustedGoalPush)
  );
}

export function addPlatformAgiAgent(config: ProjectConfigSummary): ProjectConfigSummary {
  return {
    ...config,
    open_code_default_agent: AGI_AGENT_NAME,
    agents: [
      {
        name: AGI_AGENT_NAME,
        path: '/workspace/AGENTS.md',
        description: 'Starts specialized Kortix sessions and coordinates their work.',
        mode: 'primary',
        source: 'opencode',
        enabled: true,
        sandbox: AGI_SANDBOX_SLUG,
        scope: {
          env: [],
          connectors: [],
          kortix_cli: [...PLATFORM_AGI_AGENT_ACTIONS],
        },
      },
      ...config.agents.filter((agent) => agent.name !== AGI_AGENT_NAME),
    ],
  };
}

export function buildPlatformAgiOpenCodeConfig(): string {
  return JSON.stringify({
    agent: {
      [AGI_AGENT_NAME]: {
        description: 'Starts specialized Kortix sessions and coordinates their work.',
        mode: 'primary',
        prompt:
          'Follow /workspace/AGENTS.md. Coordinate through the Kortix CLI. You are the only coordinator. Claim each task, spawn one specialized worker, then register its immutable bounds and initial prompt with `kortix tasks worker` before waiting. A `queued` worker state or empty new session means prompt delivery is pending, not no-progress. For each settled turn, submit exactly one outcome with its stable settlement id: evidence through `kortix tasks progress --settlement-id`, or no evidence through `kortix tasks no-progress --settlement-id`. Reuse an id only to retry the same outcome; the server permits one continuation, then blocks and escalates. Never ask a worker to spawn another session.',
      },
    },
  });
}

/**
 * The platform coordinator receives only the control-plane leaves needed to
 * coordinate bounded work. It cannot push, merge, stop arbitrary sessions,
 * administer IAM, or read project secrets and connectors.
 *
 * The project-bound PAT and the launching user's IAM role remain the outer
 * authorization boundaries. Project secrets and connectors stay unavailable
 * because the coordinator delegates project work to specialized sessions.
 */
export function resolvePlatformAgiSandbox(requestedSlug: string | null | undefined): string {
  if (requestedSlug && requestedSlug !== AGI_SANDBOX_SLUG) {
    throw new Error('AGI_SANDBOX_LOCKED');
  }
  return AGI_SANDBOX_SLUG;
}
