import {
  META_AGENT_NAME,
  META_SANDBOX_SLUG,
} from '@kortix/shared';
import type { AgentGrant } from '@kortix/db';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import type { ProjectConfigSummary } from '../git/types';

/** Per-project opt-in for the platform coordinator (Settings → Feature flags). */
export function projectMetaAgentEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'meta_agent');
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
          kortix_cli: 'all',
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
 * The platform coordinator can manage every surface inside its bound project.
 *
 * The project-bound PAT and the launching user's IAM role remain the outer
 * authorization boundaries. Project secrets and connectors stay unavailable
 * because the coordinator delegates project work to specialized sessions.
 */
export function platformMetaAgentGrant(): AgentGrant {
  return {
    agent: META_AGENT_NAME,
    kortixCli: 'all',
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
