export const META_AGENT_NAME = 'meta';
export const META_SANDBOX_SLUG = 'meta';

export function isMetaAgentName(name: string | null | undefined): boolean {
  return name === META_AGENT_NAME;
}
