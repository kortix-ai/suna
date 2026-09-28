/**
 * A config release is prepared as the platform's own copy; a working tree is
 * not. OpenCode runs on the boot link, a symlink to the release, and npm's
 * Arborist re-extracts the whole node_modules tree when its root is a symlink
 * (boot regression 2026-09-22: old-starter opencode-ready 14,366 ms vs 7,656).
 * A release must leave OpenCode's installer nothing to do.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareConfigDir, preparePlatformConfigDir } from '../harness/open-code/config-release'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-prep-'))
  const dir = join(root, 'config')
  const bakedDir = join(root, 'baked')
  await mkdir(dir, { recursive: true })
  await mkdir(join(bakedDir, 'node_modules'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.17.11', replicate: '^1.4.0' } }),
  )
  await writeFile(join(dir, 'bun.lock'), '{"project":true}')
  await writeFile(join(bakedDir, 'bun.lock'), '{"baked":true}')
  await writeFile(join(bakedDir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.18.23' } }))
  const install = async (staging: string) => {
    const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
    for (const name of Object.keys(pkg.dependencies)) {
      await mkdir(join(staging, 'node_modules', name), { recursive: true })
      await writeFile(join(staging, 'node_modules', name, 'package.json'), '{}')
    }
  }
  return { root, dir, deps: { bakedDir, install } }
}

describe('release preparation', () => {
  test('a release gets the binary plugin pin and the install sentinel', async () => {
    const { root, dir, deps } = await fixture()
    try {
      await preparePlatformConfigDir(dir, join(root, 'no-managed-skills'), deps)
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@opencode-ai/plugin']).toBe('1.18.23')
      expect(JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')).kortixOpenCodeInstallSentinel).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a working-tree config dir keeps its pin and gets no sentinel', async () => {
    const { root, dir, deps } = await fixture()
    try {
      await prepareConfigDir(dir, join(root, 'no-managed-skills'), deps)
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@opencode-ai/plugin']).toBe('1.17.11')
      expect(existsSync(join(dir, 'package-lock.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('every release staging site prepares with preparePlatformConfigDir', () => {
    // Both the convergence and the one boot path materialize releases.
    const source = [
      readFileSync(join(import.meta.dir, '../harness/open-code/config-release.ts'), 'utf8'),
      readFileSync(join(import.meta.dir, '../harness/open-code/boot-config-path.ts'), 'utf8'),
    ].join('\n')
    // `prepare` of each materializeRelease call builds a release staging dir.
    const stagingPrepares = source.match(/prepare: [^\n]*\(staged\)[^\n]*/g) ?? []
    expect(stagingPrepares.length).toBe(2)
    // Either by name, or through the boot path's injectable seam with
    // `platformOwned: true` — never the working-tree preparation.
    for (const line of stagingPrepares) {
      expect(line.includes('preparePlatformConfigDir(staged') || line.includes('(staged, true)')).toBe(true)
      expect(line).not.toContain('prepareConfigDir(staged')
    }
    // …and that seam really maps `true` to the platform-owned preparation.
    const bootPath = readFileSync(join(import.meta.dir, '../harness/open-code/boot-config-path.ts'), 'utf8')
    const seam = bootPath.slice(bootPath.indexOf('function defaultPrepare('))
    expect(seam.slice(0, seam.indexOf('\n}')))
      .toContain('platformOwned\n      ? preparePlatformConfigDir(dir, input.managedSkillsDir)')
  })
})
