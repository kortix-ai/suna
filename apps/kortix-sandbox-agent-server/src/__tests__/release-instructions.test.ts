/**
 * OpenCode resolves a relative `instructions` entry against the session
 * directory (`/workspace`), never against its config dir (session/instruction.ts
 * `globUp(instruction, ctx.directory, ctx.worktree)`, OpenCode 1.18.23). With a
 * config release that read the session's checkout instead of the base branch's
 * files (2026-10-05). The platform plugin rewrites those entries to the release.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RELEASE_INSTRUCTIONS_PLUGIN_SOURCE } from '@/harness/open-code/release-instructions'
import { buildOpencodeConfigContent } from '@/harness/open-code/lifecycle'

const ID = 'a'.repeat(64)
let root: string
let previousDir: string | undefined

async function runHook(servedDir: string, instructions: unknown): Promise<unknown> {
  const link = join(root, 'boot')
  rmSync(link, { force: true })
  symlinkSync(servedDir, link)
  process.env.OPENCODE_CONFIG_DIR = link
  const file = join(root, `plugin-${crypto.randomUUID()}.js`)
  writeFileSync(file, RELEASE_INSTRUCTIONS_PLUGIN_SOURCE)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, () => Promise<{ config: (c: unknown) => Promise<void> }>>
  const hooks = await mod.KortixReleaseInstructions!()
  const config = { instructions }
  await hooks.config(config)
  return config.instructions
}

beforeEach(() => {
  // Real path: macOS's tmpdir is a symlink (/var → /private/var), and the plugin resolves links.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'release-instructions-')))
  previousDir = process.env.OPENCODE_CONFIG_DIR
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousDir
  rmSync(root, { recursive: true, force: true })
})

describe('the release instructions plugin', () => {
  test('a relative entry resolves inside the release root, as it would at the root of /workspace', async () => {
    const release = join(root, 'config', ID)
    mkdirSync(join(release, 'harnesses', 'opencode'), { recursive: true })
    const out = await runHook(join(release, 'harnesses', 'opencode'), [
      'rules/RULES.md',
      'rules/*.md',
      './AGENTS.md',
      '/tmp/kortix/config-release.md',
      '~/global.md',
      'https://example.test/rules.md',
      '**/CONTRIBUTING.md',
    ])
    expect(out).toEqual([
      join(release, 'rules/RULES.md'),
      join(release, 'rules/*.md'),
      join(release, 'AGENTS.md'),
      '/tmp/kortix/config-release.md',
      '~/global.md',
      'https://example.test/rules.md',
      '**/CONTRIBUTING.md',
    ])
  })

  test('off the release path (the working tree, the image default) nothing changes', async () => {
    const workspace = join(root, 'workspace', 'harnesses', 'opencode')
    mkdirSync(workspace, { recursive: true })
    expect(await runHook(workspace, ['rules/RULES.md'])).toEqual(['rules/RULES.md'])
    expect(await runHook(workspace, undefined)).toBeUndefined()
  })
})

describe('the composed config', () => {
  test('carries the plugin only while OpenCode serves a release', async () => {
    const plugins = async (servesRelease: boolean) => {
      const content = await buildOpencodeConfigContent({}, { servesRelease })
      return (JSON.parse(content ?? '{}').plugin ?? []) as string[]
    }
    expect((await plugins(true)).some((p) => p.endsWith('/kortix-release-instructions.js'))).toBe(true)
    expect((await plugins(false)).some((p) => p.endsWith('/kortix-release-instructions.js'))).toBe(false)
  })
})
