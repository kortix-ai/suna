export const AGI_AGENT_NAME = 'agi';
export const AGI_SANDBOX_SLUG = 'agi';

export function isAgiAgentName(name: string | null | undefined): boolean {
  return name === AGI_AGENT_NAME;
}
