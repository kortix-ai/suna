/**
 * Kortix-owned OpenCode environment values.
 *
 * Apply these values after project environment merging. A project cannot
 * override a platform safety decision through its secret or runtime env.
 */
const MANAGED_OPENCODE_ENV = {
  KORTIX_CONTINUATION_DISABLED: '1',
} as const

export function applyManagedOpencodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...MANAGED_OPENCODE_ENV,
  }
}
