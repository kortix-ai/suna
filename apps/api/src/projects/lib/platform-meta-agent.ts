import {
  META_AGENT_NAME,
  META_SANDBOX_SLUG,
} from '@kortix/shared';
import type { AgentGrant } from '@kortix/db';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { PROJECT_ACTIONS } from '../../iam/actions';
import type { ProjectConfigSummary } from '../git/types';

const PLATFORM_META_AGENT_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_GOAL_READ,
  PROJECT_ACTIONS.PROJECT_GOAL_WRITE,
  PROJECT_ACTIONS.PROJECT_TASK_READ,
  PROJECT_ACTIONS.PROJECT_TASK_WRITE,
  PROJECT_ACTIONS.PROJECT_CR_OPEN,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
] as const;

/** Per-project opt-in for the platform coordinator (Settings → Feature flags). */
export function projectMetaAgentEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'meta_agent');
}

/** Enable the platform coordinator for an explicit trusted goal push. */
export function platformMetaAgentEnabledForSession(
  projectMetadata: unknown,
  requestedAgent: string | null,
  trustedGoalPush: boolean,
): boolean {
  return (
    projectMetaAgentEnabled(projectMetadata) ||
    (requestedAgent === META_AGENT_NAME && trustedGoalPush)
  );
}

export function addPlatformMetaAgent(config: ProjectConfigSummary): ProjectConfigSummary {
  return {
    ...config,
    open_code_default_agent: META_AGENT_NAME,
    agents: [
      {
        name: META_AGENT_NAME,
        path: '/workspace/AGENTS.md',
        description: 'Starts specialized Kortix sessions and coordinates their work.',
        mode: 'primary',
        source: 'opencode',
        enabled: true,
        sandbox: META_SANDBOX_SLUG,
        scope: {
          env: [],
          connectors: [],
          kortix_cli: [...PLATFORM_META_AGENT_ACTIONS],
        },
      },
      ...config.agents.filter((agent) => agent.name !== META_AGENT_NAME),
    ],
  };
}

export function buildPlatformMetaOpenCodeConfig(): string {
  return JSON.stringify({
    agent: {
      [META_AGENT_NAME]: {
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
export function platformMetaAgentGrant(): AgentGrant {
  return {
    agent: META_AGENT_NAME,
    kortixCli: [...PLATFORM_META_AGENT_ACTIONS],
    connectors: [],
    env: [],
  };
}

export function resolvePlatformMetaSandbox(requestedSlug: string | null | undefined): string {
  if (requestedSlug && requestedSlug !== META_SANDBOX_SLUG) {
    throw new Error('META_SANDBOX_LOCKED');
  }
  return META_SANDBOX_SLUG;
}
