import type { KortixProject } from '@kortix/sdk/projects-client';

/** True when this project routes LLM calls through the managed gateway. */
export function isLlmGatewayEnabled(project: KortixProject | undefined): boolean {
  if (!project) return false;
  if (project.experimental?.llm_gateway === true) return true;
  return (
    project.experimental_features?.some(
      (feature) => feature.key === 'llm_gateway' && feature.enabled,
    ) ?? false
  );
}

/** True when the platform exposes LLM Gateway for this project (may still be toggled off). */
export function isLlmGatewayAvailable(project: KortixProject | undefined): boolean {
  return (
    project?.experimental_features?.some(
      (feature) => feature.key === 'llm_gateway' && feature.available,
    ) ?? false
  );
}
