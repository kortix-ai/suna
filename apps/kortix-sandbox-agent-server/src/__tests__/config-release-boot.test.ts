/**
 * THE boot path (`bootOpenCodeConfig`), against real Git repositories, real
 * archives, a fake API over HTTP and a fake OpenCode that serves whichever
 * directory the boot link names.
 *
 * What these assert is the contract, not the implementation:
 *   C2 "proven" is OpenCode answering its session API on the candidate dir.
 *   C3 the readiness gate opens only after a proof, never before.
 *   C4 `/workspace` is never a candidate while `config_releases` is on.
 *   C6 no timer decides the config: the release is waited for.
 *   C7 valve A (present but does not load) and valve B (store/API unreachable).
 *   C8 flag off is one early return to the pre-release behaviour.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  activateBootConfig,
  materializeRelease,
  readBootConfigPointer,
  readBootLinkTarget,
  readQuarantine,
  releaseDir,
  type ReleaseManifest,
} from '../boot-config'
import type { ConfigReleaseApi } from '../config-release/api-client'
import { bootOpenCodeConfig, type BootConfigPathResult } from '../harness/open-code/boot-config-path'
import { configReleaseReport, resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import type { OpenCodeConfig } from '../harness/open-code/config'
import {
  buildRelease,
  commitAll,
  FEATURE_DISABLED,
  git,
  initRepo,
  REPOSITORY_CHANGED,
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

/** The fake OpenCode: it serves the agents and tools of `served.dir`. */
const served = { dir: '', configError: false }
let opencodeServer: ReturnType<typeof Bun.serve>

beforeAll(() => {
  opencodeServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const dir = served.dir
      if (served.configError) {
        return Response.json({ name: 'ConfigJsonError', data: { path: join(dir, 'opencode.jsonc'), message: 'PropertyNameExpected at line 1, column 2' } }, { status: 400 })
      }
      if (url.pathname === '/session') return Response.json([])
      if (url.pathname === '/config') return Response.json({ default_agent: 'kortix' })
      if (url.pathname === '/agent') {
        return Response.json([{ name: 'kortix', mode: 'primary' }, { name: 'general', mode: 'subagent' }])
      }
      if (url.pathname === '/experimental/tool/ids') {
        const tools = existsSync(join(dir, 'tools'))
          ? readdirSync(join(dir, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => basename(f, '.ts'))
          : []
        return Response.json(['bash', 'read', ...tools])
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => opencodeServer.stop(true))

function cfg(): OpenCodeConfig {
  return { projectTarget: work, defaultBranch: 'main', defaultOpencodeConfigDir: defaultDir } as unknown as OpenCodeConfig
}
const client = (): ConfigReleaseApi => ({ apiUrl: api.url, projectId: 'proj-1', sessionId: 'ses-1', token: 'sandbox-token' })

interface BootRun {
  result: BootConfigPathResult
  /** Every directory the boot link named, in order. */
  servedDirs: string[]
  starts: number
  respawns: number
  /** Whether the gate was open at the moment each proof ran. */
  gateOpenAtProof: boolean[]
  gateOpened: boolean
}

type Overrides = Partial<Parameters<typeof bootOpenCodeConfig>[0]>

async function boot(
  overrides: Overrides | ((run: BootRun) => Overrides) = {},
  opts: { workspaceError?: string | null } = {},
): Promise<BootRun> {
  const run: BootRun = { result: null as never, servedDirs: [], starts: 0, respawns: 0, gateOpenAtProof: [], gateOpened: false }
  const serve = async () => {
    const target = await readBootLinkTarget(store)
    if (target) {
      run.servedDirs.push(target)
      served.dir = target
    }
  }
  run.result = await bootOpenCodeConfig({
    cfg: cfg(),
    api: client(),
    root: store,
    workspace: Promise.resolve(opts.workspaceError ?? null),
    proofBudgetMs: 4_000,
    proofOptions: { requestTimeoutMs: 300, hangLimit: 2, pollMs: 25 },
    prepare: async () => undefined,
    opencode: {
      getInternalUrl: () => `http://127.0.0.1:${opencodeServer.port}`,
      markWorkspaceReady: () => {
        run.gateOpened = true
      },
    },
    start: async () => {
      run.starts++
      await serve()
    },
    respawn: async () => {
      run.respawns++
      await serve()
    },
    // Candidate 0 reuses the process from step 0: the link is repointed and the
    // composed config rewritten, with no respawn.
    refresh: async () => {
      await serve()
      return true
    },
    prove: async (baseUrl, deadline, input) => {
      run.gateOpenAtProof.push(run.gateOpened)
      const { provenCheck } = await import('../harness/open-code/proven-check')
      return provenCheck(baseUrl, deadline, input)
    },
    ...(typeof overrides === 'function' ? overrides(run) : overrides),
  })
  return run
}

async function installProvenRelease(built: BuiltRelease = release, proven = true): Promise<string> {
  const d = built.descriptor
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
  const { dir } = await materializeRelease({ root: store, manifest, archive: built.archive })
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
  resetConfigReleaseStateForTests()
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
  served.configError = false
  root = mkdtempSync(join(tmpdir(), 'kortix-boot-path-'))
  work = join(root, 'work')
  store = join(root, 'store')
  defaultDir = join(root, 'image-default')
  mkdirSync(join(defaultDir, 'tools'), { recursive: true })
  writeFileSync(join(defaultDir, 'opencode.jsonc'), '{}\n')
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

describe('the desired release is what the box runs', () => {
  test('a fresh box downloads it, proves it, writes the pointer and reports it', async () => {
    const run = await boot()
    const dir = releaseDir(store, release.descriptor.release_id!)

    expect(run.result).toMatchObject({
      dir,
      source: 'release',
      releaseId: release.descriptor.release_id,
      sourceCommit: release.descriptor.source_commit,
      proven: true,
      fallbackReason: null,
      failedReleaseId: null,
      releasesEnabled: true,
    })
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('RELEASE PROMPT\n')
    // C6: the box waited for the release. No timer, no placeholder left behind.
    expect(run.servedDirs.at(-1)).toBe(dir)
    expect(run.respawns).toBe(0)
    expect((await readBootConfigPointer(store))).toMatchObject({ release_id: release.descriptor.release_id, proven: true })
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(GOV)
    // C4: the session's own checkout was never a candidate.
    expect(run.servedDirs).not.toContain(join(work, DIR))
    expect(git(work, 'status', '--porcelain')).toBe('')
  })

  test('C3: the readiness gate opens only after the proof', async () => {
    const run = await boot()
    expect(run.gateOpenAtProof).toEqual([false])
    expect(run.gateOpened).toBe(true)
  })

  test('C0: the early spawn starts on the image default, before the config is known', async () => {
    const run = await boot()
    expect(run.starts).toBe(1)
    expect(await readBootLinkTarget(store)).toBe(releaseDir(store, release.descriptor.release_id!))
    expect(api.archiveRequests.length).toBe(1)
  })

  test('an intact copy from an earlier boot is reused without a download', async () => {
    await installProvenRelease()
    api.archiveRequests.length = 0
    const run = await boot()
    expect(run.result.source).toBe('release')
    expect(api.archiveRequests).toHaveLength(0)
  })
})

describe('valve A: present, but it does not load', () => {
  test('a release that fails its proof is quarantined and the image default runs, proved', async () => {
    let proofs = 0
    const run = await boot((tracked) => ({
      prove: async (baseUrl, deadline, input) => {
        proofs += 1
        tracked.gateOpenAtProof.push(tracked.gateOpened)
        // The release fails; the image default answers.
        if (proofs === 1) return { ok: false, fatal: true, reason: 'ConfigJsonError in opencode.jsonc: PropertyNameExpected at line 1, column 2' }
        const { provenCheck } = await import('../harness/open-code/proven-check')
        return provenCheck(baseUrl, deadline, input)
      },
    }))
    expect(run.result.source).toBe('image-default')
    expect(run.result.dir).toBe(defaultDir)
    expect(run.result.proven).toBe(true)
    expect(run.result.failedReleaseId).toBe(release.descriptor.release_id!)
    expect(run.result.fallbackReason).toMatch(/release \w{12} failed: ConfigJsonError/)
    expect((await readQuarantine(store))[release.descriptor.release_id!]).toBeTruthy()
    // Every step down is served and respawned, and the gate still follows the proof.
    expect(run.respawns).toBe(1)
    expect(run.gateOpenAtProof).toEqual([false, false])
    // C4 again: the step below a failed release is the image default, not /workspace.
    expect(run.servedDirs).not.toContain(join(work, DIR))
  })

  test('the last proven release is the step between a failed release and the image default', async () => {
    const previous = await installProvenRelease()
    write(work, `${DIR}/agents/kortix.md`, 'NEWER PROMPT\n')
    const newer = buildRelease(work, commitAll(work, 'newer'), DIR, { governance: GOV })
    serveRelease(api, newer)

    let proofs = 0
    const run = await boot({
      prove: async (baseUrl, deadline, input) => {
        proofs += 1
        if (proofs === 1) return { ok: false, fatal: true, reason: 'the newer release does not load' }
        const { provenCheck } = await import('../harness/open-code/proven-check')
        return provenCheck(baseUrl, deadline, input)
      },
    })
    expect(run.result).toMatchObject({ dir: previous, source: 'release', releaseId: release.descriptor.release_id, proven: true })
    expect(run.result.failedReleaseId).toBe(newer.descriptor.release_id!)
    expect(run.result.fallbackReason).toMatch(/the newer release does not load/)
  })

  test('the image default is the floor: it runs even unproven, and says so', async () => {
    const run = await boot({ prove: async () => ({ ok: false, fatal: true, reason: 'nothing loads on this box' }) })
    expect(run.result).toMatchObject({ dir: defaultDir, source: 'image-default', proven: false })
    expect(run.result.fallbackReason).toMatch(/image default config failed: nothing loads on this box/)
    expect(run.gateOpened).toBe(true)
  })
})

describe('valve B: the store or the API could not be reached', () => {
  test('an unreachable API runs the previously available verified copy, and names the cause', async () => {
    const dir = await installProvenRelease()
    api.stop()
    const run = await boot()
    expect(run.result).toMatchObject({ dir, source: 'release', releaseId: release.descriptor.release_id, proven: true })
    expect(run.result.fallbackReason).toMatch(/the API could not be asked for this session's release/)
    expect(configReleaseReport().desired_release_id).toBeNull()
  })

  test('an unreachable API with nothing on disk runs the image default, and names the cause', async () => {
    api.stop()
    const run = await boot()
    expect(run.result).toMatchObject({ dir: defaultDir, source: 'image-default', proven: true, releaseId: null })
    expect(run.result.fallbackReason).toMatch(/the API could not be asked/)
  })

  test('an archive the store cannot serve falls back without quarantining the release', async () => {
    await installProvenRelease()
    const previousDir = releaseDir(store, release.descriptor.release_id!)
    tamper(previousDir)
    api.archives.clear()
    const run = await boot()
    expect(run.result.source).toBe('image-default')
    expect(run.result.fallbackReason).toMatch(/could not be built: archive request answered 404/)
    expect(run.result.fallbackReason).toMatch(/no longer verifies on disk/)
    expect(await readQuarantine(store)).toEqual({})
  })

  test('a quarantined desired release is skipped with its reason, not retried', async () => {
    const dir = await installProvenRelease()
    const { quarantineRelease } = await import('../boot-config')
    write(work, `${DIR}/agents/kortix.md`, 'NEWER PROMPT\n')
    const newer = buildRelease(work, commitAll(work, 'newer'), DIR, { governance: GOV })
    serveRelease(api, newer)
    await quarantineRelease(store, newer.descriptor.release_id!, 'it failed here before')
    api.archiveRequests.length = 0

    const run = await boot()
    expect(run.result).toMatchObject({ dir, source: 'release', releaseId: release.descriptor.release_id })
    expect(run.result.fallbackReason).toMatch(/is quarantined on this box: it failed here before/)
    expect(api.archiveRequests).toHaveLength(0)
  })

  test('a previous-repository session keeps its config with no fallback reason', async () => {
    const dir = await installProvenRelease()
    api.respond(REPOSITORY_CHANGED)
    const run = await boot()
    expect(run.result).toMatchObject({ dir, source: 'release', proven: true, fallbackReason: null, releasesEnabled: true })
  })
})

describe('C8: config releases off is one early return to the pre-release behaviour', () => {
  test('the flag off boots the workspace config dir and ignores the pointer', async () => {
    await installProvenRelease()
    api.respond(FEATURE_DISABLED)
    const run = await boot()
    expect(run.result).toMatchObject({
      dir: join(work, DIR),
      source: 'workspace',
      releaseId: null,
      proven: true,
      fallbackReason: null,
      releasesEnabled: false,
    })
    expect(configReleaseReport().mode).toBeNull()
    // Nothing is proved and nothing is quarantined: it is the pre-PR path.
    expect(run.gateOpenAtProof).toEqual([])
    expect(await readQuarantine(store)).toEqual({})
  })

  test('no workspace opencode.json falls to the image default, still with no release', async () => {
    unlinkSync(join(work, DIR, 'opencode.jsonc'))
    api.respond(FEATURE_DISABLED)
    const run = await boot()
    expect(run.result).toMatchObject({ dir: defaultDir, source: 'image-default', releasesEnabled: false })
  })

  test('a box with no API at all takes the same branch', async () => {
    const run = await boot({ api: null })
    expect(run.result).toMatchObject({ dir: join(work, DIR), source: 'workspace', releasesEnabled: false })
  })

  test('a repository that did not materialize never reads the checkout', async () => {
    api.respond(FEATURE_DISABLED)
    const run = await boot({}, { workspaceError: 'clone failed' })
    expect(run.result).toMatchObject({ dir: defaultDir, source: 'image-default', releasesEnabled: false })
  })
})

describe('degenerate clones change nothing about the config', () => {
  test('no clone, an empty clone and a foreign clone all boot the current release', async () => {
    const dir = releaseDir(store, release.descriptor.release_id!)

    // No clone at all.
    rmSync(work, { recursive: true, force: true })
    expect((await boot()).result).toMatchObject({ dir, source: 'release', proven: true })

    // An empty clone.
    resetConfigReleaseStateForTests()
    mkdirSync(work, { recursive: true })
    expect((await boot()).result).toMatchObject({ dir, source: 'release', proven: true })

    // A foreign clone with its own, different config dir.
    resetConfigReleaseStateForTests()
    write(work, `${DIR}/opencode.jsonc`, '{ "default_agent": "someone-elses" }\n')
    write(work, `${DIR}/agents/other.md`, 'FOREIGN\n')
    expect((await boot()).result).toMatchObject({ dir, source: 'release', proven: true })
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('RELEASE PROMPT\n')
  })
})
