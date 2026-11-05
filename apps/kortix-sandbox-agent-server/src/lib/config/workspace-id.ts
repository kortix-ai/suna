/**
 * The workspace this box serves: `KORTIX_WORKSPACE_ID`, else
 * `KORTIX_PROJECT_ID`. Both carry the same value (the workspace id is the
 * project id). `KORTIX_PROJECT_ID` stays permanently: a box started before the
 * API injected `KORTIX_WORKSPACE_ID` has only it. `KORTIX_WORKSPACE_ID` wins
 * when both are set, the same rule as the CLI (`apps/cli/src/project-link.ts`).
 *
 * Not `KORTIX_WORKSPACE`: that is the `/workspace` directory path.
 *
 * Returns '' when neither is set.
 */
export function workspaceIdFromEnv(env: Record<string, string | undefined>): string {
  return env.KORTIX_WORKSPACE_ID?.trim() || env.KORTIX_PROJECT_ID?.trim() || ''
}
