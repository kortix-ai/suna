import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureOpencodeConfigDeps } from '../opencode-config-deps'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ensureOpencodeConfigDeps', () => {
  it('links the baked node_modules + bun.lock into a config dir that declares deps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'replicate'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')
      await writeFile(join(bakedDir, 'bun.lock'), '{}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      // node_modules is a symlink pointing at the baked tree…
      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      // …and resolves through to the baked package.
      expect(await exists(join(configDir, 'node_modules', 'replicate'))).toBe(true)
      // bun.lock copied in so opencode's own install verifies as a no-op.
      expect(await exists(join(configDir, 'bun.lock'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no-ops when the config dir declares no deps (no package.json)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules'), { recursive: true })

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await exists(join(configDir, 'node_modules'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves an already-satisfied config dir untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'existing'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      // The pre-existing real node_modules is kept (not replaced by the baked symlink).
      expect(await exists(join(configDir, 'node_modules', 'existing'))).toBe(true)
      expect(await exists(join(configDir, 'node_modules', 'baked-only'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
