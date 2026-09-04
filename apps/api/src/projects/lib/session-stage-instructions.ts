import { resolveFeatureFlag } from '../../feature-flags/registry';

export const STAGE_INSTRUCTIONS_ENV_NAME = 'KORTIX_STAGE_INSTRUCTIONS';

/**
 * The always-on stage protocol for the sandbox agent. The `kortix-cli` skill
 * only loads on demand, so a plain chat never saw the board rules and every
 * card sat in Backlog. Both runtimes append this to the system prompt:
 * OpenCode via an instruction file (kortix-sandbox-agent-server
 * stage-instructions.ts), the pi worker via its baked overlay.
 */
export const STAGE_INSTRUCTIONS = `# Monitoring board — report your stage (required)

This project shows every session as a card on a board:
backlog → planning → ready → in_progress → review → done.
Only you move your card; people cannot. Run the kortix CLI with the bash tool (the session id defaults to $KORTIX_SESSION_ID):

1. Your FIRST tool call on every new task, before reading or editing anything: \`kortix sessions stage planning\`
2. BEFORE you ask the user anything — a question, a choice, approval of a plan — run \`kortix sessions stage ready --needs-approval --note "<one line>"\`, then ask, then end your turn. Asking without this call is a protocol violation. The answer arrives as your next prompt.
3. When you start executing (also for small tasks you do directly, and right after an approval arrives): \`kortix sessions stage in_progress\`
4. When your work is ready for a person to look at (change request opened, answer written): \`kortix sessions stage review --note "<one line>"\`
5. When the user confirms it is finished, or nothing is left to do: \`kortix sessions stage done\`

Before you end ANY turn, run the stage command that matches your state. Never end a turn with the card still on planning or in_progress when you are actually waiting on a person or finished. If the command answers 403 "not enabled", Monitoring is off — skip these calls.
`;

/** `{ KORTIX_STAGE_INSTRUCTIONS }` when the project has Monitoring on, else `{}`. */
export function monitoringStageInstructionsEnv(projectMetadata: unknown): Record<string, string> {
  return resolveFeatureFlag(projectMetadata, 'monitoring')
    ? { [STAGE_INSTRUCTIONS_ENV_NAME]: STAGE_INSTRUCTIONS }
    : {};
}
