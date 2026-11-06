/**
 * The workspace this box serves: `KORTIX_WORKSPACE_ID`, else
 * `KORTIX_PROJECT_ID`. Both carry the same value (the workspace id is the
 * project id). The API injects `KORTIX_PROJECT_ID` only, so a script's own
 * `KORTIX_PROJECT_ID=<other>` is never outranked by an injected value.
 * `KORTIX_WORKSPACE_ID` wins when someone sets both, the same rule as the CLI
 * (`apps/cli/src/project-link.ts`).
 *
 * Not `KORTIX_WORKSPACE`: that is the `/workspace` directory path.
 *
 * Returns '' when neither is set.
 */
export function workspaceIdFromEnv(env: Record<string, string | undefined>): string {
  return env.KORTIX_WORKSPACE_ID?.trim() || env.KORTIX_PROJECT_ID?.trim() || ''
}
