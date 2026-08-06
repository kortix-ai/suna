import type { AgentGrant } from '@kortix/db';
import { META_AGENT_NAME, META_SANDBOX_SLUG } from '@kortix/shared';
import { resolveExperimentalFeature } from '../../experimental/features';
import { PROJECT_ACTIONS } from '../../iam/actions';
import type { ProjectConfigSummary } from '../git/types';

const PLATFORM_META_AGENT_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DELETE,
  PROJECT_ACTIONS.PROJECT_CR_OPEN,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,
  PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
  PROJECT_ACTIONS.PROJECT_GATEWAY_LOGS_READ,
  PROJECT_ACTIONS.PROJECT_GATEWAY_SPEND_READ,
  PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET,
  PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_FILE_WRITE,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  PROJECT_ACTIONS.PROJECT_REVIEW_READ,
  PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT,
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
] as const;

/** Per-project opt-in for the platform coordinator (Customize → Experimental). */
export function projectMetaAgentEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'meta_agent');
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
          'Follow /workspace/AGENTS.md. Coordinate work through the Kortix CLI. You are the only coordinator: spawn specialized sessions to do the work, give each one bounded task via --prompt, and never ask a session to spawn further sessions.',
      },
    },
  });
}

/**
 * The platform coordinator can manage project surfaces except landing code.
 *
 * Merge actions stay absent from this explicit allowlist. An added project
 * action therefore does not silently grant the coordinator new authority.
 * Project secrets and connectors stay unavailable because the coordinator
 * delegates project work to specialized sessions.
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
