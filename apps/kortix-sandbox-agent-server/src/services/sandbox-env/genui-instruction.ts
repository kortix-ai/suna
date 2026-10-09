import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildGenuiPrompt } from '@kortix/sdk/genui'

/** Set by the API (projects/lib/genui-env.ts) at provisioning. Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI'
export const GENUI_INSTRUCTION_PATH = '/tmp/kortix/genui.md'

let promptText: string | null = null

export function genuiEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env[GENUI_ENV_NAME] === '1'
}

/** The generated catalog prompt, computed once per process. */
export function genuiPromptText(): string {
  promptText ??= buildGenuiPrompt()
  return promptText
}

/**
 * Flag on: write the prompt atomically and return the path. Flag off: remove any file an earlier
 * boot of this sandbox left behind, and return null, so OpenCode never reads a stale instruction.
 */
export function writeGenuiInstruction(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  path = GENUI_INSTRUCTION_PATH,
): string | null {
  if (!genuiEnabled(env)) {
    rmSync(path, { force: true })
    return null
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, genuiPromptText(), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return path
}

/** pi: the catalog for the root agent when the flag is on; null for subagents and when off. */
export function genuiPromptSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  isChild: boolean,
): string | null {
  return !isChild && genuiEnabled(env) ? genuiPromptText() : null
}
