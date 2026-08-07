import type { AgentGrant } from '@kortix/db';
import { META_AGENT_NAME, META_SANDBOX_SLUG } from '@kortix/shared';
import { resolveExperimentalFeature } from '../../experimental/features';
import { PROJECT_ACTIONS } from '../../iam/actions';
import type { ProjectConfigSummary } from '../git/types';

const PLATFORM_META_AGENT_ACTIONS = [
  // Five nouns only: project/tasks/goals, CR, session, file, and Git state.
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_CR_OPEN,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
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
 * The platform coordinator can read project/repository state, mutate generated
 * goal/task state, start/read/chat/wait sessions, and open a CR.
 *
 * It cannot push or merge Git state. It also cannot delete projects, stop
 * sessions, administer IAM, mutate triggers, manage gateway keys or budgets,
 * write project files, submit reviews, or read/mutate secrets and connectors.
 * Workers receive their own separately bounded project grants.
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
