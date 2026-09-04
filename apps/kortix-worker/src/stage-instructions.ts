/**
 * The Monitoring stage protocol, authored by the API
 * (apps/api/src/projects/lib/session-stage-instructions.ts) and delivered as
 * KORTIX_STAGE_INSTRUCTIONS only when the project has the `monitoring` flag
 * on. Appended to whatever system prompt won (env override or baked agent
 * prompt) so the agent moves its card whichever runtime it boots on.
 */
export const STAGE_INSTRUCTIONS_ENV_NAME = 'KORTIX_STAGE_INSTRUCTIONS';

export function withStageInstructions(systemPrompt: string, env: NodeJS.ProcessEnv): string {
  const body = env[STAGE_INSTRUCTIONS_ENV_NAME]?.trim();
  return body ? `${systemPrompt}\n\n${body}` : systemPrompt;
}
