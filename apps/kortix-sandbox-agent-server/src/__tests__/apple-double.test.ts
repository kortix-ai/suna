import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneAppleDoubleFiles } from '../apple-double'

const dirs: string[] = []

function poisonedConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-appledouble-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'tools', 'lib'), { recursive: true })
  mkdirSync(join(dir, 'agents'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true })

  writeFileSync(join(dir, 'opencode.jsonc'), '{"theme":"system"}\n')
  writeFileSync(join(dir, 'tools', 'web_search.ts'), 'export const tool = 1\n')
  writeFileSync(join(dir, 'tools', 'lib', 'get-env.ts'), 'export const env = 1\n')
  writeFileSync(join(dir, 'agents', 'kortix.md'), '# kortix\n')

  const sidecar = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00])
  writeFileSync(join(dir, '._opencode.jsonc'), sidecar)
  writeFileSync(join(dir, '._tools'), sidecar)
  writeFileSync(join(dir, 'tools', '._web_search.ts'), sidecar)
  writeFileSync(join(dir, 'tools', 'lib', '._get-env.ts'), sidecar)
  writeFileSync(join(dir, 'agents', '._kortix.md'), sidecar)
  writeFileSync(join(dir, 'node_modules', 'zod', '._index.js'), sidecar)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pruneAppleDoubleFiles — repairing a macOS-baked config dir', () => {
  test('removes every sidecar OpenCode would try to build, at any depth', async () => {
    const dir = poisonedConfigDir()

    const removed = await pruneAppleDoubleFiles(dir)

    expect(removed).toBe(5)
    expect(existsSync(join(dir, '._opencode.jsonc'))).toBe(false)
    expect(existsSync(join(dir, '._tools'))).toBe(false)
    expect(existsSync(join(dir, 'tools', '._web_search.ts'))).toBe(false)
    expect(existsSync(join(dir, 'tools', 'lib', '._get-env.ts'))).toBe(false)
    expect(existsSync(join(dir, 'agents', '._kortix.md'))).toBe(false)
  })

  test('leaves every real tool, agent, and config file untouched', async () => {
    const dir = poisonedConfigDir()

    await pruneAppleDoubleFiles(dir)

    expect(readFileSync(join(dir, 'opencode.jsonc'), 'utf8')).toBe('{"theme":"system"}\n')
    expect(readFileSync(join(dir, 'tools', 'web_search.ts'), 'utf8')).toBe('export const tool = 1\n')
    expect(readFileSync(join(dir, 'tools', 'lib', 'get-env.ts'), 'utf8')).toBe('export const env = 1\n')
    expect(readFileSync(join(dir, 'agents', 'kortix.md'), 'utf8')).toBe('# kortix\n')
  })

  test('does not walk node_modules', async () => {
    const dir = poisonedConfigDir()

    await pruneAppleDoubleFiles(dir)

    expect(existsSync(join(dir, 'node_modules', 'zod', '._index.js'))).toBe(true)
  })

  test('reports nothing removed for a clean dir and never throws on a missing one', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'kortix-appledouble-clean-'))
    dirs.push(clean)
    writeFileSync(join(clean, 'opencode.jsonc'), '{}\n')

    expect(await pruneAppleDoubleFiles(clean)).toBe(0)
    expect(await pruneAppleDoubleFiles(join(clean, 'does-not-exist'))).toBe(0)
  })
})
