/**
 * Kortix-owned OpenCode environment values.
 *
 * Apply these values after project environment merging. A project cannot
 * override a platform safety decision through its secret or runtime env.
 */
import { MANAGED_OPENCODE_OUTPUT_TOKEN_MAX } from '@kortix/api-contract/fallback-models'

const MANAGED_OPENCODE_ENV = {
  KORTIX_CONTINUATION_DISABLED: '1',
  OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(MANAGED_OPENCODE_OUTPUT_TOKEN_MAX),
} as const

export function applyManagedOpencodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...MANAGED_OPENCODE_ENV,
  }
}
