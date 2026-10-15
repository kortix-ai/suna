import {
  CompiledAgentConfigEnvError,
  readCompiledAgentConfigEnv,
  writeCompiledAgentConfigEnv,
} from '@kortix/api-contract/compiled-agent-config-env'
import { logger } from '@/lib/log/logger'

/**
 * The compiled agent config (agents, prompts, permissions, model) as this env
 * carries it, or undefined for none.
 *
 * Read it through this function, never as `env.KORTIX_COMPILED_AGENT_CONFIG`.
 * A config over 128 KiB is not under that name: it arrives, and is kept,
 * gzip-encoded in parts (`@kortix/api-contract/compiled-agent-config-env`). A
 * damaged gzip form is logged and reads as no config, the same as a raw value
 * that is not JSON.
 */
export function compiledAgentConfigFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readCompiledAgentConfigEnv(env)
  } catch (err) {
    if (!(err instanceof CompiledAgentConfigEnvError)) throw err
    logger.warn('[config] compiled agent config in env cannot be read; ignoring', { err: err.message })
    return undefined
  }
}

/**
 * Point `env` at `config`, or clear it with `null`.
 *
 * OpenCode, git, every PTY and every other child inherit the daemon's env.
 * Linux refuses to exec a child whose env holds one string over 128 KiB, so an
 * oversized config is stored gzip-encoded in parts, never raw.
 */
export function setCompiledAgentConfigEnv(env: NodeJS.ProcessEnv, config: string | null): void {
  writeCompiledAgentConfigEnv(env, config)
}
