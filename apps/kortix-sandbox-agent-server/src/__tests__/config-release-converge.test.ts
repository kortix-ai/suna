/**
 * The apply sequence: the daemon applies the release the API assigns.
 *
 * Real Git repositories, real archives served by a fake API over HTTP, and a
 * fake OpenCode over HTTP that serves the agents and tools of whichever
 * directory it was spawned on. The lifecycle is a fake with the real contract:
 * `reloadVerified` runs the proven check on the candidate before promotion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { quarantineRelease, readBootConfigPointer, readQuarantine, releaseDir } from '../boot-config'
import type { ConfigReleaseApi } from '../config-release/api-client'
import type { OpenCodeConfig } from '../harness/open-code/config'
import { CONFIG_RELEASE_NOTICE_PATH, clearConfigReleaseNotice, writeConfigReleaseNotice } from '../config-release/notice'
import {
  ConvergeBusyError,
  configReleaseReport,
  convergeConfigRelease,
  fetchBootRelease,
  proveBootConfig,
  proveBootFallback,
  recordBootConfig,
  resolveBootConfig,
  resetConfigReleaseStateForTests,
  runningSourceCommit,
  type BootRelease,
} from '../harness/open-code/config-release'
import type { Opencode, VerifiedReloadOptions, VerifiedReloadResult } from '../harness/open-code/lifecycle'
import { provenCheck, toolNamesFromFiles } from '../harness/open-code/proven-check'
import {
  buildRelease,
  commitAll,
  git,
  initRepo,
  FEATURE_DISABLED,
  REPOSITORY_CHANGED,
  serveRelease,
  startFakeApi,
  write,
  type BuiltRelease,
  type FakeApi,
} from './helpers/config-release-fixtures'

const DIR = '.kortix/opencode'
const GOV_V1 = '{"agent":{"kortix":{"prompt":"v1"}}}'
const GOV_V2 = '{"agent":{"kortix":{"prompt":"v2"}}}'

let root: string
let origin: string
let work: string
let store: string
let overlay: string
let defaultDir: string
let api: FakeApi

/**
 * A fake OpenCode. It answers for the directory the lifecycle last spawned:
 * agents from `agents/*.md`, `default_agent` from `opencode.jsonc`, tools from
 * `tools/*.ts` minus the ones a "missing dependency" dropped.
 */
const served = { dir: '', droppedTools: new Set<string>(), toolRoute: true }
let opencodeServer: ReturnType<typeof Bun.serve>

beforeAll(() => {
  opencodeServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const dir = served.dir
      // As real OpenCode 1.18.31 answers (measured 2026-09-22): a syntax error
      // in opencode.jsonc → 400 ConfigJsonError on every directory route; a
      // plugin that throws at import → the session API serves, the config
      // routes never answer.
      let config: Record<string, unknown> = {}
      let configText = ''
      try {
        configText = readFileSync(join(dir, 'opencode.jsonc'), 'utf8')
        config = JSON.parse(configText)
      } catch {
        if (configText) {
          return Response.json(
            {
              name: 'ConfigJsonError',
              data: {
                path: join(dir, 'opencode.jsonc'),
                message: `\n--- JSONC Input ---\n${configText}\n--- Errors ---\nInvalidSymbol at line 1, column 20\n   Line 1: x\n--- End ---`,
              },
            },
            { status: 400 },
          )
        }
      }
      if (url.pathname === '/session') return Response.json([])
      const throwingPlugin =
        existsSync(join(dir, 'plugins')) &&
        readdirSync(join(dir, 'plugins')).some((f) => readFileSync(join(dir, 'plugins', f), 'utf8').includes('throw'))
      if (throwingPlugin) return new Promise<Response>(() => undefined)
      if (url.pathname === '/config') return Response.json(config)
      if (url.pathname === '/agent') {
        const names = existsSync(join(dir, 'agents'))
          ? readdirSync(join(dir, 'agents')).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'))
          : []
        return Response.json([
          ...names.map((name) => ({ name, mode: 'primary' })),
          // OpenCode's built-in agents.
          { name: 'build', mode: 'primary' },
          { name: 'general', mode: 'subagent' },
        ])
      }
      if (url.pathname === '/experimental/tool/ids') {
        if (!served.toolRoute) return new Response('not found', { status: 404 })
        const tools = existsSync(join(dir, 'tools'))
          ? readdirSync(join(dir, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => basename(f, '.ts'))
          : []
        return Response.json(['bash', 'read', ...tools.filter((tool) => !served.droppedTools.has(tool))])
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  opencodeServer.stop(true)
})

interface FakeOpencode {
  opencode: Pick<Opencode, 'useConfigDir' | 'getConfigDir' | 'reloadVerified' | 'getPid' | 'getInternalUrl'>
  state: {
    dir: string
    pid: number | null
    reloads: number
    governanceAtSpawn: Array<string | undefined>
    pointerAtProof: Array<string | null>
  }
}

function fakeOpencode(opts: { startFails?: boolean; notStarted?: boolean; pid?: number | null } = {}): FakeOpencode {
  const state: FakeOpencode['state'] = {
    dir: join(work, DIR),
    pid: opts.pid === undefined ? 100 : opts.pid,
    reloads: 0,
    governanceAtSpawn: [],
    pointerAtProof: [],
  }
  served.dir = state.dir
  const opencode = {
    useConfigDir(next: string) {
      const previous = state.dir
      state.dir = next
      return previous
    },
    getConfigDir: () => state.dir,
    getPid: () => state.pid,
    // The live process is the fake OpenCode, serving whatever `served.dir` holds.
    getInternalUrl: () => `http://127.0.0.1:${opencodeServer.port}`,
    async reloadVerified(options: VerifiedReloadOptions = {}): Promise<VerifiedReloadResult> {
      state.reloads++
      state.governanceAtSpawn.push(process.env.KORTIX_COMPILED_AGENT_CONFIG)
      if (opts.notStarted) return { outcome: 'kept-old', reason: 'opencode binary not resolved yet', candidateFailed: false }
      if (opts.startFails) return { outcome: 'kept-old', reason: 'the new opencode did not start', candidateFailed: true }
      const previousServed = served.dir
      served.dir = state.dir
      state.pointerAtProof.push((await readBootConfigPointer(store))?.release_id ?? null)
      const proof = options.prove
        ? await options.prove(`http://127.0.0.1:${opencodeServer.port}`, Date.now() + 1_500)
        : { ok: true as const }
      if (!proof.ok) {
        served.dir = previousServed
        return { outcome: 'kept-old', reason: proof.reason, candidateFailed: true }
      }
      state.pid = (state.pid ?? 0) + 1
      return { outcome: 'swapped', port: 4097, pid: state.pid, turnEnded: false }
    },
  }
  return { opencode, state }
}

function cfg(): OpenCodeConfig {
  return {
    projectTarget: work,
    workspace: work,
    defaultBranch: 'main',
    defaultOpencodeConfigDir: defaultDir,
  } as unknown as OpenCodeConfig
}

function client(): ConfigReleaseApi {
  return { apiUrl: api.url, projectId: 'proj-1', sessionId: 'ses-1', token: 'sandbox-token' }
}

const prepared: string[] = []
function converge(oc: FakeOpencode, over: { api?: ConfigReleaseApi | null } = {}) {
  return convergeConfigRelease({
    cfg: cfg(),
    opencode: oc.opencode,
    root: store,
    managedSkillsDir: overlay,
    api: over.api === undefined ? client() : over.api,
    proofBudgetMs: 1_500,
    prepare: async (dir) => {
      prepared.push(dir)
      cpSync(overlay, join(dir, 'skills'), { recursive: true, force: true })
    },
  })
}

function baseRelease(governance: string | null = GOV_V1): BuiltRelease {
  return buildRelease(origin, git(origin, 'rev-parse', 'HEAD'), DIR, { governance })
}

beforeEach(() => {
  resetConfigReleaseStateForTests()
  prepared.length = 0
  served.droppedTools = new Set()
  served.toolRoute = true
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
  root = mkdtempSync(join(tmpdir(), 'kortix-converge-'))
  origin = join(root, 'origin')
  work = join(root, 'work')
  store = join(root, 'store')
  overlay = join(root, 'managed-skills')
  defaultDir = join(root, 'image-default')
  mkdirSync(defaultDir, { recursive: true })
  writeFileSync(join(defaultDir, 'opencode.jsonc'), '{}\n')
  write(overlay, 'kortix-cli/SKILL.md', 'OVERLAY\n')
  initRepo(origin)
  write(origin, `${DIR}/opencode.jsonc`, '{"default_agent":"kortix"}\n')
  write(origin, `${DIR}/agents/kortix.md`, 'PROMPT v1\n')
  write(origin, `${DIR}/tools/scrape.ts`, 'export default {}\n')
  commitAll(origin, 'base')
  git(root, 'clone', '--quiet', `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1')
  api = startFakeApi('sandbox-token')
})

afterEach(() => {
  api.stop()
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

describe('convergeConfigRelease — follow-base', () => {
  test('applies the release: new dir, governance at spawn, proven pointer, clean workspace', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    const id = release.descriptor.release_id!

    const response = await converge(oc)

    expect(response).toEqual({
      ok: true,
      outcome: 'applied',
      config: {
        release_id: id,
        desired_release_id: id,
        source: 'release',
        mode: 'follow-base',
        proven: true,
        fallback_reason: null,
        failed_release_id: null,
      },
      reload: { how: 'restarted', turn_ended: false },
      reason: null,
    })
    expect(oc.state.dir).toBe(releaseDir(store, id))
    expect(readFileSync(join(oc.state.dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    expect(oc.state.governanceAtSpawn).toEqual([GOV_V1])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(release.descriptor.compiled_governance_etag!)
    expect(await readBootConfigPointer(store)).toEqual({
      release_id: id,
      source_commit: release.descriptor.source_commit!,
      config_dir: DIR,
      dir: releaseDir(store, id),
      proven: true,
    })
    expect(runningSourceCommit()).toBe(release.descriptor.source_commit!)
    expect(prepared).toEqual([expect.stringMatching(new RegExp(`${id}\\.[0-9a-f-]+\\.tmp$`))])
    expect(git(work, 'status', '--porcelain')).toBe('')
    // The descriptor request has no inputs at all.
    expect(api.descriptorRequests.at(-1)!.body).toEqual({})
  })

  test('the pointer is written only after the proof', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    await converge(oc)
    expect(oc.state.pointerAtProof).toEqual([null])
    expect(await readBootConfigPointer(store)).not.toBeNull()
  })

  test('the same release twice is a no-op: no download, no respawn', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    await converge(oc)
    const downloads = api.archiveRequests.length
    const response = await converge(oc)
    expect(response.outcome).toBe('unchanged')
    expect(response.reload).toBeNull()
    expect(oc.state.reloads).toBe(1)
    expect(api.archiveRequests.length).toBe(downloads)
  })

  test('a governance-only change is a new release on the same archive', async () => {
    const first = baseRelease(GOV_V1)
    serveRelease(api, first)
    const oc = fakeOpencode()
    await converge(oc)
    const second = baseRelease(GOV_V2)
    expect(second.descriptor.config_tree_id).toBe(first.descriptor.config_tree_id)
    expect(second.descriptor.release_id).not.toBe(first.descriptor.release_id)
    serveRelease(api, second)
    const response = await converge(oc)
    expect(response.outcome).toBe('applied')
    expect(oc.state.governanceAtSpawn).toEqual([GOV_V1, GOV_V2])
  })

  test('a null governance does not wipe the running one', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = GOV_V1
    serveRelease(api, baseRelease(null))
    const oc = fakeOpencode()
    expect((await converge(oc)).outcome).toBe('applied')
    expect(oc.state.governanceAtSpawn).toEqual([GOV_V1])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(GOV_V1)
  })

  test('a tampered or extended running copy is rebuilt before the respawn', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)
    const dir = oc.state.dir
    spawnSync('chmod', ['-R', 'u+w', dir])
    writeFileSync(join(dir, 'agents/kortix.md'), 'TAMPERED\n')
    writeFileSync(join(dir, 'agents/rogue.md'), 'ADDED\n')

    const response = await converge(oc)

    expect(response.outcome).toBe('applied')
    expect(oc.state.reloads).toBe(2)
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    expect(existsSync(join(dir, 'agents/rogue.md'))).toBe(false)
  })

  test('a base move reaches a session whose own branch diverged', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    await converge(oc)
    write(work, 'app.ts', 'session work outside the config dir\n')
    commitAll(work, 'session work')
    write(origin, `${DIR}/agents/kortix.md`, 'PROMPT v2\n')
    commitAll(origin, 'update agent')
    const next = baseRelease()
    serveRelease(api, next)
    expect((await converge(oc)).outcome).toBe('applied')
    expect(readFileSync(join(oc.state.dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v2\n')
    expect(git(work, 'status', '--porcelain')).toBe('')
  })
})

describe('convergeConfigRelease — failures keep the running config', () => {
  test('declined: a dropped tool fails the proof; old dir, old pointer, quarantine, governance restored', async () => {
    const good = baseRelease(GOV_V1)
    serveRelease(api, good)
    const oc = fakeOpencode()
    await converge(oc)
    const goodDir = oc.state.dir

    write(origin, `${DIR}/tools/firecrawl.ts`, 'import x from "@mendable/firecrawl-js"\nexport default x\n')
    commitAll(origin, 'add a tool with a missing dependency')
    served.droppedTools = new Set(['firecrawl'])
    const bad = baseRelease(GOV_V2)
    serveRelease(api, bad)

    const response = await converge(oc)

    expect(response.outcome).toBe('declined')
    expect(response.ok).toBe(false)
    expect(response.reason).toBe('tools not loaded: firecrawl')
    expect(response.config).toMatchObject({
      release_id: good.descriptor.release_id,
      desired_release_id: bad.descriptor.release_id,
      source: 'release',
      failed_release_id: bad.descriptor.release_id,
      fallback_reason: 'tools not loaded: firecrawl',
    })
    expect(oc.state.dir).toBe(goodDir)
    expect((await readBootConfigPointer(store))!.release_id).toBe(good.descriptor.release_id!)
    expect(Object.keys(await readQuarantine(store))).toEqual([bad.descriptor.release_id!])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(GOV_V1)
  })

  test('a missing default agent fails the proof', async () => {
    write(origin, `${DIR}/opencode.jsonc`, '{"default_agent":"ghost"}\n')
    commitAll(origin, 'default agent without a file')
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('declined')
    expect(response.reason).toBe('the default agent "ghost" is not loaded')
    expect(oc.state.dir).toBe(join(work, DIR))
    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('a quarantined release is not retried; a new release ID is not blocked', async () => {
    const bad = baseRelease()
    serveRelease(api, bad)
    const failing = fakeOpencode({ startFails: true })
    expect((await converge(failing)).outcome).toBe('declined')
    const downloads = api.archiveRequests.length

    const again = await converge(failing)
    expect(again.outcome).toBe('quarantined')
    expect(again.config.failed_release_id).toBe(bad.descriptor.release_id)
    expect(failing.state.reloads).toBe(1)
    expect(api.archiveRequests.length).toBe(downloads)

    write(origin, `${DIR}/agents/kortix.md`, 'PROMPT fixed\n')
    commitAll(origin, 'fix')
    serveRelease(api, baseRelease())
    const healthy = fakeOpencode()
    expect((await converge(healthy)).outcome).toBe('applied')
  })

  test('a reload that could not start a candidate does not quarantine', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode({ notStarted: true })
    expect((await converge(oc)).outcome).toBe('declined')
    expect(await readQuarantine(store)).toEqual({})
  })

  test('opencode not running: failed, nothing replaced, nothing quarantined', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode({ pid: null })
    const response = await converge(oc)
    expect(response.outcome).toBe('failed')
    expect(oc.state.reloads).toBe(0)
    expect(await readQuarantine(store)).toEqual({})
  })

  test('an archive that does not match the descriptor is refused and not quarantined', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    write(origin, `${DIR}/agents/kortix.md`, 'SWAPPED IN STORAGE\n')
    const other = buildRelease(origin, commitAll(origin, 'other'), DIR)
    api.archives.set(release.descriptor.config_tree_id!, other.archive)
    api.respond({
      status: 200,
      json: { ...release.descriptor, archive: { ...release.descriptor.archive!, bytes: other.archive.length } },
    })
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('failed')
    expect(response.reason).toMatch(/does not match its blob ID/)
    expect(oc.state.reloads).toBe(0)
    expect(await readQuarantine(store)).toEqual({})
    expect(existsSync(releaseDir(store, release.descriptor.release_id!))).toBe(false)
  })

  test('an unreachable API keeps the running config', async () => {
    const oc = fakeOpencode()
    const response = await converge(oc, { api: { ...client(), apiUrl: 'http://127.0.0.1:1/v1' } })
    expect(response.outcome).toBe('failed')
    expect(oc.state.reloads).toBe(0)
    expect(oc.state.dir).toBe(join(work, DIR))
  })

  test('an API that predates the spec (404) keeps the running config', async () => {
    api.respond({ status: 404, json: { error: 'not found' } })
    const response = await converge(fakeOpencode())
    expect(response.outcome).toBe('failed')
    expect(response.reason).toMatch(/404/)
  })

  test('single flight: a second convergence while one runs is refused', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    const first = converge(oc)
    await expect(converge(oc)).rejects.toBeInstanceOf(ConvergeBusyError)
    expect((await first).outcome).toBe('applied')
  })
})

describe('convergeConfigRelease — other sources', () => {
  test('a session that edited its own config dir still runs the base release', async () => {
    // There is no session-files mode. /workspace stays the editable clone; an
    // edit there reaches the box only once it is pushed to the base branch.
    const good = baseRelease()
    serveRelease(api, good)
    const oc = fakeOpencode()
    await converge(oc)
    const dir = releaseDir(store, good.descriptor.release_id!)
    expect(oc.state.dir).toBe(dir)

    write(work, `${DIR}/agents/kortix.md`, 'SESSION EDIT\n')
    const response = await converge(oc)

    expect(response.outcome).toBe('unchanged')
    expect(response.config).toMatchObject({ source: 'release', mode: 'follow-base', proven: true })
    expect(oc.state.dir).toBe(dir)
    // The descriptor request carries no inputs at all.
    expect(api.descriptorRequests.at(-1)!.body).toEqual({})

    // The edit reaches the box by being pushed to the base branch.
    write(origin, `${DIR}/agents/kortix.md`, 'SESSION EDIT\n')
    const pushed = buildRelease(origin, commitAll(origin, 'adopt the edit'), DIR, { governance: GOV_V1 })
    serveRelease(api, pushed)
    const after = await converge(oc)
    expect(after.outcome).toBe('applied')
    expect(after.config.release_id).toBe(pushed.descriptor.release_id!)
    expect(oc.state.dir).toBe(releaseDir(store, pushed.descriptor.release_id!))
  })

  test('repository access withheld: the image default dir runs with the governance', async () => {
    const release = baseRelease(GOV_V2)
    const etag = release.descriptor.compiled_governance_etag!
    // The spec's shape: release_id = sha256(":" + etag), no tree, no archive.
    api.respond({
      status: 200,
      json: {
        ...release.descriptor,
        release_id: createHash('sha256').update(`:${etag}`).digest('hex'),
        config_dir: null,
        config_tree_id: null,
        archive: null,
        files: null,
        reason: 'repository access withheld',
      },
    })
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('applied')
    expect(response.ok).toBe(true)
    expect(response.config).toMatchObject({ source: 'image-default', fallback_reason: null, proven: true })
    expect(oc.state.dir).toBe(defaultDir)
    expect(oc.state.governanceAtSpawn).toEqual([GOV_V2])
    expect(api.archiveRequests.length).toBe(0)
    expect((await converge(oc)).outcome).toBe('unchanged')
  })

  test('the API withheld shape (release_id null) runs the image default; a governance change converges', async () => {
    const release = baseRelease(GOV_V1)
    // apps/api toDescriptor for a session without repository access.
    const withheld = (governance: string, etag: string) => ({
      ...release.descriptor,
      release_id: null,
      config_dir: null,
      config_tree_id: null,
      archive: null,
      files: null,
      compiled_governance: governance,
      compiled_governance_etag: etag,
      reason: 'repository access withheld',
    })
    api.respond({ status: 200, json: withheld(GOV_V1, release.descriptor.compiled_governance_etag!) })
    const oc = fakeOpencode()
    const first = await converge(oc)
    expect(first.outcome).toBe('applied')
    expect(first.config.release_id).toMatch(/^[0-9a-f]{64}$/)
    expect(first.config.source).toBe('image-default')
    expect((await converge(oc)).outcome).toBe('unchanged')

    const v2 = baseRelease(GOV_V2)
    api.respond({ status: 200, json: withheld(GOV_V2, v2.descriptor.compiled_governance_etag!) })
    const second = await converge(oc)
    expect(second.outcome).toBe('applied')
    expect(second.config.release_id).not.toBe(first.config.release_id)
    expect(oc.state.governanceAtSpawn).toEqual([GOV_V1, GOV_V2])
  })

  test('a governance compile failure is no release: running config kept', async () => {
    const release = baseRelease()
    api.respond({
      status: 200,
      json: {
        ...release.descriptor,
        release_id: null,
        config_dir: null,
        config_tree_id: null,
        archive: null,
        files: null,
        compiled_governance: null,
        compiled_governance_etag: null,
        reason: 'compiled governance failed: agent kortix not found',
      },
    })
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('failed')
    expect(response.reason).toBe('compiled governance failed: agent kortix not found')
    expect(oc.state.reloads).toBe(0)
  })

  test('no release (config dir over the limit): running config kept, reason reported', async () => {
    const release = baseRelease()
    api.respond({
      status: 200,
      json: { ...release.descriptor, release_id: null, archive: null, files: null, reason: 'config dir exceeds 4 MiB' },
    })
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('failed')
    expect(response.reason).toBe('config dir exceeds 4 MiB')
    expect(oc.state.reloads).toBe(0)
  })

  test('the boot record seeds the running state the next convergence compares against', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)
    resetConfigReleaseStateForTests()
    recordBootConfig({
      source: 'release',
      release_id: release.descriptor.release_id,
      source_commit: release.descriptor.source_commit,
      proven: true,
    })
    expect(configReleaseReport().release_id).toBe(release.descriptor.release_id)
    expect(configReleaseReport().mode).toBeNull()
    const unchanged = await converge(oc)
    expect(unchanged.outcome).toBe('unchanged')
    expect(unchanged.config.mode).toBe('follow-base')
  })
})

describe('provenCheck', () => {
  test('tool names are the base names of top-level tools/*.ts', () => {
    expect(
      toolNamesFromFiles(['tools/a.ts', 'tools/nested/b.ts', 'tools/c.js', 'agents/x.md', 'tools/d.ts'] as string[]),
    ).toEqual(['a', 'd'])
  })

  test('a 404 on the tool route skips the tool condition', async () => {
    served.dir = join(root, 'probe')
    write(served.dir, 'opencode.jsonc', '{}')
    write(served.dir, 'agents/kortix.md', 'x')
    served.toolRoute = false
    const result = await provenCheck(`http://127.0.0.1:${opencodeServer.port}`, Date.now() + 1_000, {
      directory: '/workspace',
      toolNames: ['missing'],
    })
    expect(result).toEqual({ ok: true })
  })

  test('a named export registers <file>_<export> and satisfies its file', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/config') return Response.json({})
        if (path === '/agent') return Response.json([{ name: 'build', mode: 'primary' }])
        return Response.json(['bash', 'multi_first', 'multi_second'])
      },
    })
    try {
      const ok = await provenCheck(`http://127.0.0.1:${server.port}`, Date.now() + 1_000, {
        directory: '/workspace',
        toolNames: ['multi'],
      })
      expect(ok).toEqual({ ok: true })
      const missing = await provenCheck(`http://127.0.0.1:${server.port}`, Date.now() + 600, {
        directory: '/workspace',
        toolNames: ['other'],
        pollMs: 100,
      })
      expect(missing).toEqual({ ok: false, reason: 'tools not loaded: other' })
    } finally {
      server.stop(true)
    }
  })
})

describe('fresh boot from a release', () => {
  test('fetchBootRelease extracts the desired release and marks both steps', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const marks: string[] = []
    const boot = await fetchBootRelease({
      cfg: cfg(),
      api: client(),
      root: store,
      managedSkillsDir: overlay,
      prepare: async () => undefined,
      mark: (label) => marks.push(label),
    })
    expect(boot).toMatchObject({ releaseId: release.descriptor.release_id, dir: releaseDir(store, release.descriptor.release_id!) })
    expect(marks).toEqual(['config-release-fetched', 'config-release-extracted'])
    expect(api.descriptorRequests.at(-1)!.body).toEqual({})
    expect(readFileSync(join(boot!.dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    // Nothing is proven yet: the pointer waits for the proof.
    expect(await readBootConfigPointer(store)).toBeNull()

    const downloads = api.archiveRequests.length
    await fetchBootRelease({ cfg: cfg(), api: client(), root: store, managedSkillsDir: overlay, prepare: async () => undefined })
    expect(api.archiveRequests.length).toBe(downloads)
  })

  test('fetchBootRelease answers null for an older API, a session-files descriptor and a quarantined release', async () => {
    const opts = { cfg: cfg(), api: client(), root: store, prepare: async () => undefined }
    api.respond({ status: 404, json: { error: 'not found' } })
    expect(await fetchBootRelease(opts)).toBeNull()
    const release = baseRelease()
    api.respond({ status: 200, json: { ...release.descriptor, mode: 'session-files', archive: null, files: null } })
    expect(await fetchBootRelease(opts)).toBeNull()
    serveRelease(api, release)
    await quarantineRelease(store, release.descriptor.release_id!, 'failed before')
    expect(await fetchBootRelease(opts)).toBeNull()
  })

  test('the convergence after ready proves a boot release on the live process and writes the pointer', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const boot = await fetchBootRelease({ cfg: cfg(), api: client(), root: store, prepare: async () => undefined })
    const oc = fakeOpencode()
    oc.opencode.useConfigDir(boot!.dir)
    served.dir = boot!.dir
    recordBootConfig({ source: 'release', release_id: boot!.releaseId, source_commit: boot!.sourceCommit, proven: false })

    const response = await converge(oc)

    expect(response.outcome).toBe('applied')
    expect(response.reload).toBeNull()
    // DEF-1: the mode the API chose is reported once the boot release is proven.
    expect(response.config).toMatchObject({ release_id: boot!.releaseId, proven: true, source: 'release', mode: 'follow-base' })
    expect(oc.state.reloads).toBe(0)
    expect((await readBootConfigPointer(store))!.release_id).toBe(boot!.releaseId)
    expect((await converge(oc)).outcome).toBe('unchanged')
  })

  test('a boot release that fails the proof is quarantined and OpenCode steps down the chain', async () => {
    write(origin, `${DIR}/tools/firecrawl.ts`, 'export default {}\n')
    commitAll(origin, 'tool with a missing dependency')
    served.droppedTools = new Set(['firecrawl'])
    const release = baseRelease()
    serveRelease(api, release)
    const boot = await fetchBootRelease({ cfg: cfg(), api: client(), root: store, prepare: async () => undefined })
    const oc = fakeOpencode()
    oc.opencode.useConfigDir(boot!.dir)
    served.dir = boot!.dir
    recordBootConfig({ source: 'release', release_id: boot!.releaseId, source_commit: boot!.sourceCommit, proven: false })

    const response = await converge(oc)

    expect(response.outcome).toBe('declined')
    expect(response.reason).toBe('tools not loaded: firecrawl')
    expect(response.config).toMatchObject({
      source: 'workspace',
      release_id: null,
      desired_release_id: boot!.releaseId,
      failed_release_id: boot!.releaseId,
      fallback_reason: 'tools not loaded: firecrawl',
    })
    expect(oc.state.dir).toBe(join(work, DIR))
    expect(Object.keys(await readQuarantine(store))).toEqual([boot!.releaseId])
    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('a running turn defers the swap; nothing is replaced', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    const response = await convergeConfigRelease({
      cfg: cfg(),
      opencode: oc.opencode,
      root: store,
      api: client(),
      prepare: async () => undefined,
      turnInFlight: async () => true,
    })
    expect(response.outcome).toBe('failed')
    expect(response.reason).toMatch(/a turn is running/)
    expect(oc.state.reloads).toBe(0)
    expect(api.archiveRequests).toHaveLength(0)
  })
})

describe('repository replacement: a previous-repository session is frozen', () => {
  test('a 409 session_repository_changed descriptor answer is unchanged: no fallback, no quarantine, config kept', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)
    const dir = oc.state.dir
    const pointer = await readBootConfigPointer(store)

    api.respond(REPOSITORY_CHANGED)
    const response = await converge(oc)

    expect(response).toEqual({
      ok: true,
      outcome: 'unchanged',
      config: {
        release_id: release.descriptor.release_id,
        desired_release_id: release.descriptor.release_id,
        source: 'release',
        mode: 'follow-base',
        proven: true,
        fallback_reason: null,
        failed_release_id: null,
      },
      reload: null,
      reason: 'Session belongs to a previous repository',
    })
    expect(oc.state.dir).toBe(dir)
    expect(oc.state.reloads).toBe(1)
    expect(await readBootConfigPointer(store)).toEqual(pointer)
    expect(await readQuarantine(store)).toEqual({})
  })

  test('the same 409 from the archive route is unchanged too', async () => {
    serveRelease(api, baseRelease())
    api.archiveOverride = REPOSITORY_CHANGED
    const oc = fakeOpencode()
    const response = await converge(oc)
    expect(response.outcome).toBe('unchanged')
    expect(response.reason).toBe('Session belongs to a previous repository')
    expect(response.config.fallback_reason).toBeNull()
    expect(oc.state.reloads).toBe(0)
    expect(await readQuarantine(store)).toEqual({})
  })

  test('any other 409 keeps the failed handling', async () => {
    api.respond({ status: 409, json: { error: 'something else', code: 'other_conflict' } })
    const response = await converge(fakeOpencode())
    expect(response.outcome).toBe('failed')
    expect(response.reason).toMatch(/descriptor request answered 409/)
  })
})

/**
 * DEF-4 (verification 2026-09-21): a fresh session created while the base
 * branch held a broken opencode.jsonc never became ready. OpenCode started on
 * the unproven release, every session create failed with ConfigJsonError, the
 * proof waited for a readiness that never came, and nothing was reported.
 * Goal 4: a bad base config never makes a session unbootable.
 */
describe('boot proof: a broken release at boot steps down the fallback chain', () => {
  function bootOn(boot: BootRelease) {
    const oc = fakeOpencode()
    oc.opencode.useConfigDir(boot.dir)
    served.dir = boot.dir
    recordBootConfig({ source: 'release', release_id: boot.releaseId, source_commit: boot.sourceCommit, proven: false })
    const spawned: string[] = []
    return {
      oc,
      spawned,
      run: (extra: Partial<Parameters<typeof proveBootConfig>[0]> = {}) =>
        proveBootConfig({
          cfg: cfg(),
          boot,
          opencode: oc.opencode,
          root: store,
          managedSkillsDir: overlay,
          api: client(),
          prepare: async () => undefined,
          proofBudgetMs: 5_000,
          proofOptions: { requestTimeoutMs: 300, hangLimit: 2, pollMs: 50 },
          spawnOn: async (dir) => {
            spawned.push(dir)
            oc.opencode.useConfigDir(dir)
            served.dir = dir
          },
          ...extra,
        }),
    }
  }

  async function brokenMain(): Promise<BootRelease> {
    write(origin, `${DIR}/opencode.jsonc`, '{ "default_agent": "kortix",,, NOT JSON {{\n}\n')
    commitAll(origin, 'broken config on main')
    git(work, 'pull', '-q', 'origin', 'main') // a fresh session checks out the broken main too
    serveRelease(api, baseRelease())
    return (await fetchBootRelease({ cfg: cfg(), api: client(), root: store, prepare: async () => undefined }))!
  }

  test('a broken release with no proven predecessor → image default, cause reported, release quarantined; a fixed main then converges', async () => {
    const boot = await brokenMain()
    const { oc, spawned, run } = bootOn(boot)
    const restored: string[] = []

    const started = Date.now()
    const result = await run({ restoreGovernance: () => restored.push('restored') })

    expect(Date.now() - started).toBeLessThan(4_000)
    // One step down, straight to the image default: /workspace is not a step.
    expect(spawned).toEqual([defaultDir])
    expect(result).toMatchObject({ proven: true, source: 'image-default', dir: defaultDir })
    const health = configReleaseReport()
    expect(health).toEqual({
      release_id: null,
      desired_release_id: boot.releaseId,
      source: 'image-default',
      mode: 'follow-base',
      proven: true,
      // The chain is release -> last proven release -> image default. There
      // is no proven predecessor here, so the image default runs and the
      // reason names the release that failed, not a workspace step.
      fallback_reason: `release ${boot.releaseId.slice(0, 12)} failed: ConfigJsonError in opencode.jsonc: InvalidSymbol at line 1, column 20`,
      failed_release_id: boot.releaseId,
    })
    expect(Object.keys(await readQuarantine(store))).toEqual([boot.releaseId])
    expect(await readBootConfigPointer(store)).toBeNull()
    expect(restored.length).toBeGreaterThan(0)

    // The box is up on the fallback. Main is fixed: the next trigger heals it.
    write(origin, `${DIR}/opencode.jsonc`, '{"default_agent":"kortix"}\n')
    write(origin, `${DIR}/agents/kortix.md`, 'PROMPT fixed\n')
    commitAll(origin, 'fix config')
    const fixed = baseRelease()
    serveRelease(api, fixed)
    const healed = await converge(oc)
    expect(healed.outcome).toBe('applied')
    expect(healed.config).toMatchObject({
      release_id: fixed.descriptor.release_id,
      source: 'release',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
    })
    expect(readFileSync(join(oc.state.dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT fixed\n')
  })

  test('a later convergence on the same failed release keeps the step-down reason (the whole chain)', async () => {
    // Rule: the step that chose the running config saw every step of the
    // fallback chain, so its reason is the most complete one. A convergence
    // that keeps the running config for the SAME failed release re-derives
    // only its own step and keeps that reason. A different failed release
    // replaces it; a proven release clears it.
    const boot = await brokenMain()
    const { oc, run } = bootOn(boot)
    await run()
    const chain = `release ${boot.releaseId.slice(0, 12)} failed: ConfigJsonError in opencode.jsonc: InvalidSymbol at line 1, column 20`
    expect(configReleaseReport().fallback_reason).toBe(chain)

    const again = await converge(oc)
    expect(again.outcome).toBe('quarantined')
    expect(again.config).toMatchObject({ failed_release_id: boot.releaseId, fallback_reason: chain })

    // Another broken release is a new failure with its own reason.
    write(origin, `${DIR}/opencode.jsonc`, '{ "default_agent": "kortix",,, STILL NOT JSON {{\n}\n')
    commitAll(origin, 'still broken')
    const second = baseRelease()
    serveRelease(api, second)
    const next = await converge(oc)
    expect(next.config.failed_release_id).toBe(second.descriptor.release_id)
    expect(next.config.fallback_reason).not.toBe(chain)
    expect(next.config.fallback_reason).toContain('ConfigJsonError in opencode.jsonc')
  })

  test('DEF-4b: a restart after the quarantine boots the image default and is proven there', async () => {
    const boot = await brokenMain()
    await bootOn(boot).run()
    resetConfigReleaseStateForTests()

    // The daemon restarts: the desired release is quarantined on this box.
    const quarantined: Array<[string, string]> = []
    const again = await fetchBootRelease({
      cfg: cfg(),
      api: client(),
      root: store,
      prepare: async () => undefined,
      onQuarantined: (id, reason) => quarantined.push([id, reason]),
    })
    expect(again).toBeNull()
    expect(quarantined.map(([id]) => id)).toEqual([boot.releaseId])
    // The chain skips /workspace: with no proven predecessor the restart
    // resolves straight to the image default. `releasesEnabled: true` is what
    // boot passes after the API answered with a descriptor (boot.ts).
    const choice = await resolveBootConfig({ cfg: cfg(), root: store, api: client(), releasesEnabled: true })
    expect(choice.source).toBe('image-default')
    expect(choice.dir).toBe(defaultDir)
    recordBootConfig({ source: choice.source })
    const oc = fakeOpencode()
    served.dir = choice.dir
    const spawned: string[] = []

    const result = await proveBootFallback({
      cfg: cfg(),
      opencode: oc.opencode,
      current: { dir: choice.dir, source: 'image-default' },
      prior: {
        reason: `release ${boot.releaseId.slice(0, 12)} is quarantined on this box: ${quarantined[0]![1]}`,
        failedReleaseId: boot.releaseId,
      },
      root: store,
      prepare: async () => undefined,
      proofBudgetMs: 5_000,
      proofOptions: { requestTimeoutMs: 300, hangLimit: 2, pollMs: 50 },
      spawnOn: async (dir) => {
        spawned.push(dir)
        served.dir = dir
      },
    })

    expect(result).toMatchObject({ source: 'image-default', proven: true, dir: defaultDir })
    // Already on the floor: nothing further is spawned.
    expect(spawned).toEqual([])
    const cause = 'ConfigJsonError in opencode.jsonc: InvalidSymbol at line 1, column 20'
    expect(configReleaseReport()).toMatchObject({
      source: 'image-default',
      proven: true,
      failed_release_id: boot.releaseId,
      fallback_reason: `release ${boot.releaseId.slice(0, 12)} is quarantined on this box: ${cause}`,
    })
  })

  test('a healthy workspace boot is proven in place with no fallback reason', async () => {
    const oc = fakeOpencode()
    served.dir = join(work, DIR)
    recordBootConfig({ source: 'workspace' })
    const result = await proveBootFallback({
      cfg: cfg(),
      opencode: oc.opencode,
      current: { dir: join(work, DIR), source: 'workspace' },
      root: store,
      prepare: async () => undefined,
      proofBudgetMs: 5_000,
      spawnOn: async () => {
        throw new Error('no restart expected')
      },
    })
    expect(result).toMatchObject({ source: 'workspace', proven: true })
    expect(configReleaseReport()).toMatchObject({ source: 'workspace', fallback_reason: null, failed_release_id: null })
  })

  test('broken release with an intact last proven release → back on the proven release', async () => {
    serveRelease(api, baseRelease())
    await converge(fakeOpencode()) // a proven release and its pointer exist
    const proven = (await readBootConfigPointer(store))!
    const boot = await brokenMain()
    const { spawned, run } = bootOn(boot)
    const result = await run()
    expect(spawned).toEqual([proven.dir])
    expect(result).toMatchObject({ source: 'release', proven: true })
    expect(configReleaseReport()).toMatchObject({
      release_id: proven.release_id,
      failed_release_id: boot.releaseId,
      fallback_reason: `release ${boot.releaseId.slice(0, 12)} failed: ConfigJsonError in opencode.jsonc: InvalidSymbol at line 1, column 20`,
    })
    expect((await readBootConfigPointer(store))!.release_id).toBe(proven.release_id)
  })

  test('a plugin that throws at import fails the proof by its hang and names the plugin', async () => {
    write(origin, `${DIR}/plugins/boom.ts`, 'throw new Error("plugin boom at import")\nexport const P = async () => ({})\n')
    commitAll(origin, 'throwing plugin')
    git(work, 'pull', '-q', 'origin', 'main')
    serveRelease(api, baseRelease())
    const boot = (await fetchBootRelease({ cfg: cfg(), api: client(), root: store, prepare: async () => undefined }))!
    const { spawned, run } = bootOn(boot)
    await run()
    // Straight to the image default: /workspace is not a step in the chain.
    expect(spawned).toEqual([defaultDir])
    expect(configReleaseReport().fallback_reason).toBe(
      `release ${boot.releaseId.slice(0, 12)} failed: GET /config did not answer in 2 attempts; a plugin that fails at import stops the config load (plugins: plugins/boom.ts)`,
    )
  })

  test('a healthy boot release is proven in place: pointer written, mode follow-base, no respawn', async () => {
    serveRelease(api, baseRelease())
    const boot = (await fetchBootRelease({ cfg: cfg(), api: client(), root: store, prepare: async () => undefined }))!
    const marks: string[] = []
    const { spawned, run } = bootOn(boot)
    const result = await run({ mark: (label) => marks.push(label) })
    expect(result).toMatchObject({ proven: true, source: 'release', dir: boot.dir })
    expect(spawned).toEqual([])
    expect(marks).toEqual(['config-release-proven'])
    expect(configReleaseReport()).toMatchObject({ release_id: boot.releaseId, proven: true, mode: 'follow-base', fallback_reason: null })
    expect((await readBootConfigPointer(store))!.release_id).toBe(boot.releaseId)
  })
})

/**
 * The `config_releases` feature flag, off (spec, "Feature flag").
 *
 * The API answers `403 feature_disabled`. The box must then do what it did
 * before config releases existed: OpenCode reads the session's workspace
 * config dir. A box already running a release is not stranded — it reverts on
 * this very convergence and clears its boot pointer, so a later reboot does
 * not come back on the release. Nothing is quarantined, nothing retries.
 */
describe('config_releases off: the box reverts to its workspace config dir', () => {
  test('a box on a release reverts, clears the pointer, and quarantines nothing', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)
    expect(oc.state.dir).toBe(releaseDir(store, release.descriptor.release_id!))
    expect(await readBootConfigPointer(store)).not.toBeNull()

    api.respond(FEATURE_DISABLED)
    const response = await converge(oc)

    expect(response.outcome).toBe('applied')
    expect(response.ok).toBe(true)
    expect(response.reason).toMatch(/config releases are disabled/i)
    expect(response.config).toMatchObject({
      release_id: null,
      desired_release_id: null,
      source: 'workspace',
      mode: null,
      fallback_reason: null,
      failed_release_id: null,
    })
    expect(oc.state.dir).toBe(join(work, DIR))
    expect(await readBootConfigPointer(store)).toBeNull()
    expect(await readQuarantine(store)).toEqual({})
  })

  test('a box already on its workspace config dir does nothing and does not restart', async () => {
    api.respond(FEATURE_DISABLED)
    const oc = fakeOpencode()
    const response = await converge(oc)

    expect(response.outcome).toBe('unchanged')
    expect(response.reason).toMatch(/config releases are disabled/i)
    expect(oc.state.reloads).toBe(0)
    expect(oc.state.dir).toBe(join(work, DIR))
    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('repeated convergences never restart again: no retry storm', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)
    const reloadsOnRelease = oc.state.reloads

    api.respond(FEATURE_DISABLED)
    await converge(oc)
    const afterRevert = oc.state.reloads
    expect(afterRevert).toBe(reloadsOnRelease + 1)

    for (let i = 0; i < 3; i++) expect((await converge(oc)).outcome).toBe('unchanged')
    expect(oc.state.reloads).toBe(afterRevert)
  })

  test('the same 403 from the archive route reverts too', async () => {
    serveRelease(api, baseRelease())
    api.archiveOverride = FEATURE_DISABLED
    const oc = fakeOpencode()
    const response = await converge(oc)

    expect(response.outcome).toBe('unchanged')
    expect(response.reason).toMatch(/config releases are disabled/i)
    expect(response.config.fallback_reason).toBeNull()
    expect(oc.state.dir).toBe(join(work, DIR))
    expect(await readQuarantine(store)).toEqual({})
  })

  test('turning the flag back ON converges the session again, on the same box', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    await converge(oc)

    api.respond(FEATURE_DISABLED)
    expect((await converge(oc)).outcome).toBe('applied')
    expect(oc.state.dir).toBe(join(work, DIR))

    serveRelease(api, release)
    const back = await converge(oc)
    expect(back.outcome).toBe('applied')
    expect(back.config).toMatchObject({
      release_id: release.descriptor.release_id!,
      source: 'release',
      mode: 'follow-base',
      proven: true,
    })
    expect(oc.state.dir).toBe(releaseDir(store, release.descriptor.release_id!))
    expect((await readBootConfigPointer(store))!.release_id).toBe(release.descriptor.release_id!)
  })
})

/**
 * The session notice (spec, "Telling the session"). The agent's system
 * context must name the commit whose config the box runs, exactly once per
 * convergence that changed something.
 */
describe('the session is told which commit it runs', () => {
  const noticePath = join(tmpdir(), `kortix-notice-converge-${process.pid}.md`)
  const readNotice = () => (existsSync(noticePath) ? readFileSync(noticePath, 'utf8') : null)
  const noteFor = (descriptor: { source_commit: string | null; config_dir: string | null }) =>
    writeConfigReleaseNotice(
      { sourceCommit: descriptor.source_commit, configDir: descriptor.config_dir, sessionId: 'ses-1' },
      noticePath,
    )

  afterEach(() => {
    rmSync(noticePath, { force: true })
    clearConfigReleaseNotice()
  })

  test('a convergence that applies a release names its commit; an unchanged one writes nothing', async () => {
    const release = baseRelease()
    serveRelease(api, release)
    const oc = fakeOpencode()
    clearConfigReleaseNotice()
    await converge(oc)

    const applied = readFileSync(CONFIG_RELEASE_NOTICE_PATH, 'utf8')
    expect(applied).toContain(`commit ${release.descriptor.source_commit!.slice(0, 12)}`)
    expect(applied).toContain('`/workspace` is a separate checkout')
    expect(applied).toContain('pushed to the base branch')
    const mtime = statSync(CONFIG_RELEASE_NOTICE_PATH).mtimeMs

    // Nothing moved: the agent must not be told its config changed.
    expect((await converge(oc)).outcome).toBe('unchanged')
    expect(statSync(CONFIG_RELEASE_NOTICE_PATH).mtimeMs).toBe(mtime)

    // A push to the base branch: the notice names the new commit.
    write(origin, `${DIR}/agents/kortix.md`, 'PROMPT v2\n')
    const next = buildRelease(origin, commitAll(origin, 'v2'), DIR, { governance: GOV_V1 })
    serveRelease(api, next)
    expect((await converge(oc)).outcome).toBe('applied')
    const after = readFileSync(CONFIG_RELEASE_NOTICE_PATH, 'utf8')
    expect(after).toContain(`commit ${next.descriptor.source_commit!.slice(0, 12)}`)
    expect(after).not.toContain(release.descriptor.source_commit!.slice(0, 12))
  })

  test('turning the flag off clears the notice: no release runs any more', async () => {
    serveRelease(api, baseRelease())
    const oc = fakeOpencode()
    await converge(oc)
    expect(existsSync(CONFIG_RELEASE_NOTICE_PATH)).toBe(true)

    api.respond(FEATURE_DISABLED)
    await converge(oc)
    expect(existsSync(CONFIG_RELEASE_NOTICE_PATH)).toBe(false)
  })

  test('the notice is the one the composer declares as an OpenCode instruction', () => {
    // The channel is the agent's system context, not a transcript message:
    // applying a release restarts OpenCode, and `instructions` is composed at
    // every spawn, so the note survives the restart the convergence performs.
    const lifecycle = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'lifecycle.ts'), 'utf8')
    expect(lifecycle).toContain('configReleaseNoticePath: configReleaseNoticePath()')
    expect(lifecycle).toContain("import { configReleaseNoticePath } from '../../config-release/notice'")
    expect(noteFor({ source_commit: 'a'.repeat(40), config_dir: DIR })).toBe('written')
    expect(readNotice()).toContain('kortix sessions reload ses-1')
  })
})
