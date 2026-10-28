import { ignoredAgentSettings } from '@kortix/api-contract/runtime-relay';
import { BUILTIN_AGENTS, META_AGENT_NAME, type BuiltinAgentKey } from '@kortix/shared';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { MY_KORTIX_SPEC } from '../agents';
import { resolveConfigAgents } from '../git/config';
import type { ProjectConfigSummary } from '../git/types';
import { agentConfigViewV3 } from './agent-config-v2';
import { declaredBuiltinAgents, MY_KORTIX_BLOCK, resolveBuiltinAgents } from './platform-meta-agent';

/**
 * Which built-in agents a project runs: kortix.yaml `builtin_agents` first,
 * then the project's legacy `meta_agent` switch, then on. The one resolution
 * every API surface (project detail, session create, the agent-config routes)
 * reads. Lives apart from `platform-meta-agent.ts`, which must not import the
 * feature-flag registry (see its header).
 */
export function projectBuiltinAgents(
  manifest: Record<string, unknown> | null | undefined,
  projectMetadata: unknown,
): Record<BuiltinAgentKey, boolean> {
  return resolveBuiltinAgents(declaredBuiltinAgents(manifest), resolveFeatureFlag(projectMetadata, 'meta_agent'));
}

/**
 * GET /agents/:name/config for a built-in agent: the same wire shape a v3
 * agent answers (`block` = governance + `behavior`, prompt included), built
 * from its server-side block. `editable: false`: every write answers
 * `409 builtin_agent_managed`.
 */
export function builtinAgentConfigView(key: BuiltinAgentKey, defaultAgent: string | null) {
  const view = agentConfigViewV3(MY_KORTIX_BLOCK as unknown as Record<string, unknown>, null);
  return {
    agent: BUILTIN_AGENTS[key].agent,
    builtin: key,
    schema_version: 3,
    editable: false,
    default_agent: defaultAgent,
    block: { ...view.governance, behavior: view.behavior, opencode: view.behavior },
    harness: 'pi' as const,
    ignored_settings: ignoredAgentSettings('pi'),
  };
}

/**
 * The project config with My Kortix listed first and as the default agent.
 * Its row is the manifest summarizer's row for `MY_KORTIX_SPEC`, plus
 * `platform: true` and `builtin: 'my_kortix'`. A project row named `meta`
 * (the v3 validator rejects one) is replaced.
 */
export function withMyKortixAgent(config: ProjectConfigSummary): ProjectConfigSummary {
  const [row] = resolveConfigAgents(
    [{ name: META_AGENT_NAME, path: MY_KORTIX_SPEC.path, description: MY_KORTIX_BLOCK.description, mode: MY_KORTIX_BLOCK.mode, model: null, space: null }],
    { specs: [MY_KORTIX_SPEC], errors: [] },
  ).agents;
  return {
    ...config,
    default_agent: META_AGENT_NAME,
    open_code_default_agent: META_AGENT_NAME,
    agents: [
      { ...row!, platform: true, builtin: 'my_kortix' },
      ...config.agents.filter((agent) => agent.name !== META_AGENT_NAME),
    ],
  };
}
