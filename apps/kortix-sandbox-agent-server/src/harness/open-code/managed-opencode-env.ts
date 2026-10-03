/**
 * Kortix-owned OpenCode environment values.
 *
 * Apply these values after project environment merging. A project cannot
 * override a platform safety decision through its secret or runtime env.
 */
const MANAGED_OPENCODE_ENV = {
  KORTIX_CONTINUATION_DISABLED: '1',
  // OpenCode clamps max_tokens to 32,000 by default. Managed models allow
  // 65,536 (limit.output); a clamp below that cuts a large file write at
  // finish_reason "length" and the turn ends with the tool never run.
  OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '65536',
} as const

export function applyManagedOpencodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...MANAGED_OPENCODE_ENV,
  }
}
