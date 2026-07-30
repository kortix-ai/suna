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
  it('links baked node_modules when the project and baked locks match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'replicate'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      // node_modules is a symlink pointing at the baked tree…
      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      // …and resolves through to the baked package.
      expect(await exists(join(configDir, 'node_modules', 'replicate'))).toBe(true)
      // The matching project lock remains in place for OpenCode's verification.
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

  it('replaces a stale real node_modules tree when the baked lock matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'existing'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      expect(await exists(join(configDir, 'node_modules', 'existing'))).toBe(false)
      expect(await exists(join(configDir, 'node_modules', 'baked-only'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('installs a mismatched lock in staging and atomically replaces the stale tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'stale'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"ajv":"^8.0.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"config":"new"}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"baked":"old"}')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async (stagingDir) => {
          expect(await exists(join(configDir, 'node_modules', 'stale'))).toBe(true)
          await mkdir(join(stagingDir, 'node_modules', 'fresh'), { recursive: true })
        },
      })

      expect(await exists(join(configDir, 'node_modules', 'stale'))).toBe(false)
      expect(await exists(join(configDir, 'node_modules', 'fresh'))).toBe(true)
      expect(await exists(join(configDir, 'node_modules', 'baked-only'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a stale tree after staged installation fails so OpenCode installs cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'stale'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"ajv":"^8.0.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"config":"new"}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"baked":"old"}')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async () => {
          throw new Error('offline cache miss')
        },
      })

      expect(await exists(join(configDir, 'node_modules'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
