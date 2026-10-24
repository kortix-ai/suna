import type { BuiltinAgentKey } from '@kortix/shared';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { declaredBuiltinAgents, resolveBuiltinAgents } from './platform-meta-agent';

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
