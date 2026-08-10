/** Resolve the canonical Workspace id with one-generation legacy fallback. */
export function workspaceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.KORTIX_WORKSPACE_ID ?? env.KORTIX_PROJECT_ID
  const trimmed = value?.trim()
  return trimmed || undefined
}
