import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The platform plugin that makes a project's relative `instructions` entries
 * read the config release, not the session's checkout.
 *
 * OpenCode resolves a relative entry against the session directory
 * (`/workspace`), never against its config dir (session/instruction.ts
 * `globUp(instruction, ctx.directory, ctx.worktree)`, OpenCode 1.18.23). A
 * release is a checkout of the base branch at `/opt/kortix/config/<release_id>`
 * with the repository's own layout, so the same entry resolved at the release
 * root names the base branch's file. Instruction arrays are unioned across
 * config files, so only a plugin's `config` hook, which receives the live
 * config, can replace the entry instead of adding a second one.
 *
 * The release root comes from the real path of `OPENCODE_CONFIG_DIR` (the boot
 * link), read at hook time: off a release (the working tree, the image default)
 * the hook changes nothing. URLs, `~/`, absolute paths and globs in a directory
 * part keep OpenCode's own resolution.
 */
export const RELEASE_INSTRUCTIONS_PLUGIN_SOURCE = `// Written by kortixd (harness/open-code/release-instructions.ts). Do not edit.
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const RELEASE_ROOT = /^(.*\\/[0-9a-f]{64})(?:\\/|$)/

export const KortixReleaseInstructions = async () => ({
  config: async (config) => {
    let served
    try {
      served = realpathSync(process.env.OPENCODE_CONFIG_DIR ?? '')
    } catch {
      return
    }
    const root = RELEASE_ROOT.exec(served)?.[1]
    if (!root || !Array.isArray(config.instructions)) return
    config.instructions = config.instructions.map((entry) => {
      if (typeof entry !== 'string' || /^https?:\\/\\//.test(entry) || entry.startsWith('~/') || isAbsolute(entry)) return entry
      const slash = entry.lastIndexOf('/')
      if (slash !== -1 && /[*?[{]/.test(entry.slice(0, slash))) return entry
      return resolve(root, entry)
    })
  },
})
`

/** Write the plugin beside the composed config, and return its `file://` spec. */
export function writeReleaseInstructionsPlugin(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, RELEASE_INSTRUCTIONS_PLUGIN_SOURCE, { mode: 0o644 })
  return `file://${path}`
}
