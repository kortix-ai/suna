import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginFilesInDir, toolNamesInDir } from '@/harness/open-code/config-directory-inventory'

describe('config directory inventory', () => {
  test('missing directories yield empty inventories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-inventory-'))
    try {
      expect(await pluginFilesInDir(dir)).toEqual([])
      expect(await toolNamesInDir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('top-level files are sorted and filtered, not nested entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-inventory-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await mkdir(join(dir, 'tools'))
      await mkdir(join(dir, 'plugins', 'nested.ts'))
      await Promise.all(['z.js', 'a.ts', 'ignore.txt'].map((name) => writeFile(join(dir, 'plugins', name), '')))
      await Promise.all(['z.ts', 'a.ts', 'ignore.js'].map((name) => writeFile(join(dir, 'tools', name), '')))
      expect(await pluginFilesInDir(dir)).toEqual(['plugins/a.ts', 'plugins/z.js'])
      expect(await toolNamesInDir(dir)).toEqual(['a', 'z'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
