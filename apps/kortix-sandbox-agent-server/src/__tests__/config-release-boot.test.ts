/**
 * The fallback chain a starting daemon walks below the desired release:
 * last proven release → workspace config dir → image default config dir.
 * Each step down records `fallback_reason`. Real repositories and archives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateBootConfig, materializeRelease, releaseDir, type ReleaseManifest } from '../boot-config'
import type { ConfigReleaseApi } from '../config-release/api-client'
import type { OpenCodeConfig } from '../harness/open-code/config'
import { provenReleaseForEarlySpawn, resolveBootConfig } from '../harness/open-code/config-release'
import {
  buildRelease,
  commitAll,
  git,
  initRepo,
  serveRelease,
  startFakeApi,
  write,
  type BuiltRelease,
  type FakeApi,
} from './helpers/config-release-fixtures'

const DIR = '.kortix/opencode'
const GOV = '{"agent":{"kortix":{"prompt":"release"}}}'
let root: string
let work: string
let store: string
let defaultDir: string
let api: FakeApi
let release: BuiltRelease

function cfg(): OpenCodeConfig {
  return { projectTarget: work, defaultBranch: 'main', defaultOpencodeConfigDir: defaultDir } as unknown as OpenCodeConfig
}
const client = (): ConfigReleaseApi => ({ apiUrl: api.url, projectId: 'proj-1', sessionId: 'ses-1', token: 'sandbox-token' })

async function installProvenRelease(proven = true): Promise<string> {
  const d = release.descriptor
  const manifest: ReleaseManifest = {
    release_id: d.release_id!,
    source_commit: d.source_commit!,
    config_dir: d.config_dir!,
    config_tree_id: d.config_tree_id!,
    archive_url: d.archive!.url,
    archive_bytes: d.archive!.bytes,
    files: d.files!,
    compiled_governance: d.compiled_governance,
    compiled_governance_etag: d.compiled_governance_etag,
  }
  const { dir } = await materializeRelease({ root: store, manifest, archive: release.archive })
  await activateBootConfig(store, {
    release_id: manifest.release_id,
    source_commit: manifest.source_commit,
    config_dir: manifest.config_dir,
    dir,
    proven,
  })
  return dir
}

function tamper(dir: string) {
  spawnSync('chmod', ['-R', 'u+w', dir])
  writeFileSync(join(dir, 'agents/kortix.md'), 'TAMPERED\n')
}

beforeEach(() => {
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
  root = mkdtempSync(join(tmpdir(), 'kortix-release-boot-'))
  work = join(root, 'work')
  store = join(root, 'store')
  defaultDir = join(root, 'image-default')
  mkdirSync(defaultDir, { recursive: true })
  initRepo(work)
  write(work, `${DIR}/opencode.jsonc`, '{}\n')
  write(work, `${DIR}/agents/kortix.md`, 'RELEASE PROMPT\n')
  release = buildRelease(work, commitAll(work, 'base'), DIR, { governance: GOV })
  api = startFakeApi('sandbox-token')
  serveRelease(api, release)
})

afterEach(() => {
  api.stop()
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

describe('resolveBootConfig', () => {
  test('1. an intact proven release: spawn on it with its governance', async () => {
    const dir = await installProvenRelease()
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: null })
    expect(choice).toEqual({
      dir,
      source: 'release',
      release_id: release.descriptor.release_id,
      source_commit: release.descriptor.source_commit,
      fallback_reason: null,
    })
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(GOV)
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(release.descriptor.compiled_governance_etag!)
  })

  test('1b. a tampered proven release is rebuilt from the API before the spawn', async () => {
    const dir = await installProvenRelease()
    tamper(dir)
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: client() })
    expect(choice.source).toBe('release')
    expect(choice.fallback_reason).toBeNull()
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('RELEASE PROMPT\n')
    expect(api.archiveRequests).toHaveLength(1)
  })

  test('2. a tampered release that cannot be rebuilt steps down to the workspace, with a reason', async () => {
    const dir = await installProvenRelease()
    tamper(dir)
    api.archives.clear()
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: client() })
    expect(choice.dir).toBe(join(work, DIR))
    expect(choice.source).toBe('workspace')
    expect(choice.fallback_reason).toMatch(/could not be rebuilt: archive request answered 404/)

    const offline = await resolveBootConfig({ cfg: cfg(), root: store, api: null })
    expect(offline.fallback_reason).toMatch(/no longer verifies and the API is not configured/)
  })

  test('2b. a pointer that was never proven is not honoured', async () => {
    await installProvenRelease(false)
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: null })
    expect(choice.source).toBe('workspace')
    expect(choice.fallback_reason).toMatch(/was never proven/)
  })

  test('3. no workspace opencode.json: the image default, with the reason from above', async () => {
    const dir = await installProvenRelease()
    rmSync(`${dir}.json`)
    unlinkSync(join(work, DIR, 'opencode.jsonc'))
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: null })
    expect(choice.dir).toBe(defaultDir)
    expect(choice.source).toBe('image-default')
    expect(choice.fallback_reason).toMatch(/has no manifest/)
  })

  test('a box that never converged runs its workspace config with no fallback reason', async () => {
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: null })
    expect(choice).toEqual({
      dir: join(work, DIR),
      source: 'workspace',
      release_id: null,
      source_commit: null,
      fallback_reason: null,
    })
    expect(existsSync(store)).toBe(false)
    expect(git(work, 'status', '--porcelain')).toBe('')
  })
})

describe('provenReleaseForEarlySpawn', () => {
  test('names the proven release and delivers its governance', async () => {
    const dir = await installProvenRelease()
    expect(await provenReleaseForEarlySpawn(store)).toEqual({ dir })
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(GOV)
    expect(dir).toBe(releaseDir(store, release.descriptor.release_id!))
  })

  test('refuses an unproven pointer and a release without its manifest', async () => {
    const dir = await installProvenRelease(false)
    expect(await provenReleaseForEarlySpawn(store)).toBeNull()
    await installProvenRelease(true)
    rmSync(`${dir}.json`)
    expect(await provenReleaseForEarlySpawn(store)).toBeNull()
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined()
  })
})
