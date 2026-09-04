import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The Monitoring stage protocol, authored by the API
 * (apps/api/src/projects/lib/session-stage-instructions.ts) and delivered as
 * one env var only when the project has the `monitoring` flag on. Written to
 * an instruction file OpenCode always loads, the same way the secret
 * capabilities catalog is — the `kortix-cli` skill loads on demand, so a
 * plain chat never saw the board rules and every card sat in Backlog.
 */
export const STAGE_INSTRUCTIONS_ENV_NAME = 'KORTIX_STAGE_INSTRUCTIONS'
export const STAGE_INSTRUCTIONS_PATH = '/tmp/kortix/stage-instructions.md'

/** Writes the file and returns its path, or null when the env carries no protocol. */
export function writeStageInstruction(
  env: NodeJS.ProcessEnv,
  path = STAGE_INSTRUCTIONS_PATH,
): string | null {
  const body = env[STAGE_INSTRUCTIONS_ENV_NAME]?.trim()
  if (!body) return null
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return path
}
