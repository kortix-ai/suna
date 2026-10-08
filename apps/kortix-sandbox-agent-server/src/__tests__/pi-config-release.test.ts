/**
 * Config releases on pi, at the decision level: `createPiConfigReleases` with a
 * fake runtime (`idle`, `reconfigure`) against the fake API of the OpenCode
 * suites — real Git repositories, real archives, a real release store on disk.
 * The black-box path through the daemon's HTTP surface is in pi-harness.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import { createPiConfigReleases, type PiConfigReleases } from '@/harness/pi/config-release'
import { createPiControlService } from '@/harness/pi/control'
import { readBootConfigPointer, readQuarantine, releaseDir } from '@/services/config-release/boot-config'
import { ConvergeBusyError } from '@/services/config-release/release'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { createEnvRouter } from '@/routes/kortix/env'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'
import {
  FEATURE_DISABLED,
  buildRelease,
  commitAll,
  initRepo,
  serveRelease,
  startFakeApi,
  write,
  type BuiltRelease,
  type FakeApi,
} from './helpers/config-release-fixtures'

const TOKEN = 'sandbox-token'
const DIR = '.kortix/opencode'
const PROVISIONED = '{"default_agent":"build","agent":{"build":{"prompt":"provisioned at boot"}}}'

let api: FakeApi
let tmp: string
let repo: string
let root: string
let noticePath: string

beforeEach(() => {
  api = startFakeApi(TOKEN)
  tmp = mkdtempSync(join(tmpdir(), 'pi-config-release-'))
  repo = join(tmp, 'repo')
  root = join(tmp, 'store')
  noticePath = join(tmp, 'notice', 'config-release.md')
  mkdirSync(join(tmp, 'managed'), { recursive: true })
  initRepo(repo)
  resetSessionTokenHealthForTests()
})

afterEach(() => {
  api.stop()
  resetSessionTokenHealthForTests()
  // Releases are sealed read-only.
  spawnSync('chmod', ['-R', 'u+w', tmp])
  rmSync(tmp, { recursive: true, force: true })
})

const governance = (prompt: string) => JSON.stringify({ default_agent: 'build', agent: { build: { prompt } } })

/** Commit a config dir with one skill and serve its release with `prompt` as the agent. */
function release(skill: string, prompt: string): BuiltRelease {
  write(repo, `${DIR}/opencode.json`, '{}\n')
  write(repo, `${DIR}/skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: ${skill} skill\n---\nBody.\n`)
  const commit = commitAll(repo, skill)
  return buildRelease(repo, commit, DIR, { projectId: 'proj-1', governance: governance(prompt) })
}

function create(env: NodeJS.ProcessEnv = { KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED }, opts: { api?: null } = {}) {
  const sessionEnv: NodeJS.ProcessEnv = { KORTIX_SESSION_ID: 'sess-1', ...env }
  const releases = createPiConfigReleases({
    cfg: { apiUrl: api.url, projectId: 'proj-1', sandboxToken: TOKEN } as Config,
    env: sessionEnv,
    root,
    noticePath,
    managedSkillsDir: join(tmp, 'managed'),
    ...opts,
  })
  return { releases, env: sessionEnv }
}

function fakeRuntime(opts: { refuse?: string } = {}) {
  const state = { idle: true, reconfigures: 0, restarts: 0, refuse: opts.refuse ?? null }
  return {
    state,
    idle: () => state.idle,
    async reconfigure() {
      state.reconfigures += 1
      if (state.refuse) throw new Error(state.refuse)
    },
    async restart() {
      state.restarts += 1
      if (state.refuse) throw new Error(state.refuse)
    },
  }
}

const skillsOf = (releases: PiConfigReleases) => releases.skillDirs()?.map((dir) => dir.replace(`${root}/`, '')) ?? null

describe('pi config releases: boot', () => {
  test('the desired release decides the governance and the skills, and it is proven on disk', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases, env } = create()

    await releases.boot()

    const id = one.descriptor.release_id!
    expect(releases.report()).toEqual({
      release_id: id,
      desired_release_id: id,
      source: 'release',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
    })
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from release one'))
    expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(one.descriptor.compiled_governance_etag!)
    expect(skillsOf(releases)).toEqual([`${id}/skills`, `${id}/.kortix/opencode/skills`])
    expect(existsSync(join(releaseDir(root, id), DIR, 'skills', 'deploy', 'SKILL.md'))).toBe(true)
    // Sealed: an agent's write fails where it happens.
    expect(statSync(join(releaseDir(root, id), DIR, 'skills', 'deploy', 'SKILL.md')).mode & 0o222).toBe(0)
    expect((await readBootConfigPointer(root))?.release_id).toBe(id)
    expect(releases.sourceCommit()).toBe(one.descriptor.source_commit)
    expect(releases.governanceOwned()).toBe(true)
    const notice = releases.notice()!
    expect(notice).toContain(one.descriptor.source_commit!.slice(0, 12))
    expect(notice).toContain('`/workspace/.kortix/opencode`')
    // A second call joins the first; nothing is fetched again.
    const requests = api.descriptorRequests.length
    await releases.boot()
    expect(api.descriptorRequests.length).toBe(requests)
  })

  test('config releases off: pi reads the working tree, and a stale notice is removed', async () => {
    write(join(tmp, 'notice'), 'config-release.md', 'left over from an earlier boot')
    api.respond(FEATURE_DISABLED)
    const { releases, env } = create()

    await releases.boot()

    expect(releases.report()).toMatchObject({ source: 'workspace', release_id: null, desired_release_id: null, proven: true })
    expect(releases.skillDirs()).toBeNull()
    expect(existsSync(noticePath)).toBe(false)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(PROVISIONED)
    expect(releases.governanceOwned()).toBe(false)
  })

  test('no API to ask: the working tree, as before config releases', async () => {
    const { releases } = create(undefined, { api: null })
    await releases.boot()
    expect(releases.report().source).toBe('workspace')
    expect(api.descriptorRequests.length).toBe(0)
  })

  test('the archive cannot be fetched: the last release this box proved, then the image default', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    await create().releases.boot()

    // The next boot of the same box: a new release whose archive the store cannot serve.
    const two = release('review', 'from release two')
    api.respond({ status: 200, json: two.descriptor })
    api.archiveOverride = { status: 500, json: { error: 'store down' } }
    const { releases, env } = create()
    await releases.boot()

    const report = releases.report()
    expect(report).toMatchObject({
      release_id: one.descriptor.release_id,
      desired_release_id: two.descriptor.release_id,
      source: 'release',
      proven: true,
      failed_release_id: null,
    })
    expect(report.fallback_reason).toContain(`release ${two.descriptor.release_id!.slice(0, 12)} could not be built`)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from release one'))
    // Not the release's fault: nothing is quarantined, and the next trigger retries it.
    expect(await readQuarantine(root)).toEqual({})

    // A box that never proved anything: the image default, with the provisioned governance.
    spawnSync('chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    const empty = create()
    await empty.releases.boot()
    expect(empty.releases.report()).toMatchObject({ source: 'image-default', release_id: null, proven: true })
    expect(empty.releases.report().fallback_reason).toContain('could not be built')
    expect(empty.releases.skillDirs()).toEqual([])
    expect(empty.releases.notice()).toBeNull()
    expect(empty.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(PROVISIONED)
  })

  test('a governance-only release: the image default with the release governance and no project skills', async () => {
    const gov = governance('governance only')
    api.respond({
      status: 200,
      json: {
        format: 'config-release-v2',
        release_id: null,
        mode: 'follow-base',
        source_commit: null,
        config_dir: null,
        config_tree_id: null,
        archive: null,
        files: null,
        compiled_governance: gov,
        compiled_governance_etag: '0123456789abcdef',
        reason: null,
      },
    })
    const { releases, env } = create()
    await releases.boot()
    expect(releases.report()).toMatchObject({ source: 'image-default', proven: true, fallback_reason: null })
    expect(releases.report().release_id).toMatch(/^[0-9a-f]{64}$/)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(gov)
    expect(releases.skillDirs()).toEqual([])
  })
})

describe('pi config releases: convergence', () => {
  test('a base move applies in place: the runtime reconfigures once, nothing restarts, a repeat is unchanged', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases, env } = create()
    await releases.boot()
    const runtime = fakeRuntime()

    const two = release('review', 'from release two')
    serveRelease(api, two)
    const applied = await releases.converge(runtime)

    expect(applied).toMatchObject({ ok: true, outcome: 'applied', reload: null, reason: null })
    expect(applied.config).toMatchObject({ release_id: two.descriptor.release_id, desired_release_id: two.descriptor.release_id, source: 'release', proven: true })
    expect(runtime.state.reconfigures).toBe(1)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from release two'))
    expect(skillsOf(releases)).toEqual([`${two.descriptor.release_id}/skills`, `${two.descriptor.release_id}/.kortix/opencode/skills`])
    expect(releases.notice()).toContain(two.descriptor.source_commit!.slice(0, 12))
    expect((await readBootConfigPointer(root))?.release_id).toBe(two.descriptor.release_id!)

    const again = await releases.converge(runtime)
    expect(again).toMatchObject({ ok: true, outcome: 'unchanged' })
    expect(runtime.state.reconfigures).toBe(1)
  })

  test('a turn in flight defers the apply; the running config is untouched', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases, env } = create()
    await releases.boot()
    serveRelease(api, release('review', 'from release two'))
    const runtime = fakeRuntime()
    runtime.state.idle = false

    const deferred = await releases.converge(runtime)

    expect(deferred).toMatchObject({ ok: false, outcome: 'failed' })
    expect(deferred.reason).toContain('a turn is running')
    expect(deferred.config.release_id).toBe(one.descriptor.release_id)
    expect(runtime.state.reconfigures).toBe(0)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from release one'))

    runtime.state.idle = true
    expect((await releases.converge(runtime)).outcome).toBe('applied')
  })

  test('a prompt that lands while the release downloads defers the swap (the parked window)', async () => {
    serveRelease(api, release('deploy', 'from release one'))
    const { releases } = create()
    await releases.boot()
    serveRelease(api, release('review', 'from release two'))
    const runtime = fakeRuntime()

    const parked = releases.converge(runtime, { delayBeforeSwapMs: 150 })
    expect(releases.inFlight()).toBe(true)
    await Bun.sleep(30)
    runtime.state.idle = false // the prompt arrived

    const result = await parked
    expect(result.outcome).toBe('failed')
    expect(runtime.state.reconfigures).toBe(0)
    expect(releases.inFlight()).toBe(false)
    expect(await readQuarantine(root)).toEqual({})
  })

  test('a runtime that refuses the config keeps the running one; the release is quarantined', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases, env } = create()
    await releases.boot()
    const two = release('review', 'from release two')
    serveRelease(api, two)
    const runtime = fakeRuntime({ refuse: 'no model for this agent' })

    const declined = await releases.converge(runtime)

    expect(declined).toMatchObject({ ok: false, outcome: 'declined', reason: 'no model for this agent' })
    expect(declined.config).toMatchObject({
      release_id: one.descriptor.release_id,
      desired_release_id: two.descriptor.release_id,
      failed_release_id: two.descriptor.release_id,
      fallback_reason: 'no model for this agent',
    })
    // The refused config was tried, then the previous one was put back.
    expect(runtime.state.reconfigures).toBe(2)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from release one'))
    expect(skillsOf(releases)).toEqual([`${one.descriptor.release_id}/skills`, `${one.descriptor.release_id}/.kortix/opencode/skills`])
    expect(releases.notice()).toContain(one.descriptor.source_commit!.slice(0, 12))
    expect(Object.keys(await readQuarantine(root))).toEqual([two.descriptor.release_id!])

    // The same release is not tried again on this box.
    runtime.state.refuse = null
    expect((await releases.converge(runtime)).outcome).toBe('quarantined')
    expect(runtime.state.reconfigures).toBe(2)
  })

  test('governance that is not a JSON object never reaches the runtime', async () => {
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases } = create()
    await releases.boot()
    write(repo, `${DIR}/skills/broken/SKILL.md`, '---\nname: broken\ndescription: b\n---\n')
    const broken = buildRelease(repo, commitAll(repo, 'broken'), DIR, { projectId: 'proj-1', governance: '["not", "an", "object"]' })
    serveRelease(api, broken)
    const runtime = fakeRuntime()

    const declined = await releases.converge(runtime)

    expect(declined.outcome).toBe('declined')
    expect(declined.reason).toBe('the compiled governance is not a JSON object')
    expect(runtime.state.reconfigures).toBe(0)
    expect(declined.config.release_id).toBe(one.descriptor.release_id)
    expect(Object.keys(await readQuarantine(root))).toEqual([broken.descriptor.release_id!])
  })

  test('config releases turned off: the convergence returns pi to the working tree', async () => {
    serveRelease(api, release('deploy', 'from release one'))
    const { releases } = create()
    await releases.boot()
    api.respond(FEATURE_DISABLED)
    const runtime = fakeRuntime()

    const reverted = await releases.converge(runtime)

    expect(reverted.outcome).toBe('applied')
    expect(reverted.config).toMatchObject({ source: 'workspace', release_id: null, proven: true })
    expect(releases.skillDirs()).toBeNull()
    expect(existsSync(noticePath)).toBe(false)
    expect(await readBootConfigPointer(root)).toBeNull()
    // The working tree may carry a pi dir with extensions: only a start reads them.
    expect(runtime.state.restarts).toBe(1)
    // Already there: nothing to do.
    expect((await releases.converge(runtime)).outcome).toBe('unchanged')
    expect(runtime.state.restarts).toBe(1)
  })

  test('single flight: a second convergence while one runs is refused', async () => {
    serveRelease(api, release('deploy', 'from release one'))
    const { releases } = create()
    await releases.boot()
    serveRelease(api, release('review', 'from release two'))
    const runtime = fakeRuntime()
    const first = releases.converge(runtime, { delayBeforeSwapMs: 50 })
    await expect(releases.converge(runtime)).rejects.toBeInstanceOf(ConvergeBusyError)
    expect((await first).outcome).toBe('applied')
  })

  test("the release's harnesses/pi is pi's config dir: a pi skill reconfigures, an extension restarts", async () => {
    write(repo, 'harnesses/pi/extensions/hello.ts', 'export default function () {}\n')
    const one = release('deploy', 'from release one')
    serveRelease(api, one)
    const { releases } = create()
    await releases.boot()
    expect(releases.piConfigDir()).toBe(join(releaseDir(root, one.descriptor.release_id!), 'harnesses/pi'))
    const runtime = fakeRuntime()

    write(repo, 'harnesses/pi/skills/native/SKILL.md', '---\nname: native\ndescription: a pi-native skill\n---\nBody.\n')
    const two = buildRelease(repo, commitAll(repo, 'pi skill'), DIR, { projectId: 'proj-1', governance: governance('two') })
    serveRelease(api, two)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 0 })
    expect(releases.piConfigDir()).toBe(join(releaseDir(root, two.descriptor.release_id!), 'harnesses/pi'))

    write(repo, 'harnesses/pi/extensions/hello.ts', 'export default function () { return 2 }\n')
    const three = buildRelease(repo, commitAll(repo, 'extension v2'), DIR, { projectId: 'proj-1', governance: governance('two') })
    serveRelease(api, three)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 1 })
  })

  test('project tools load from the release root; a change to one restarts, an unrelated change reconfigures', async () => {
    const withTools = (prompt: string) => JSON.stringify({ ...JSON.parse(governance(prompt)), project_tools: { lookup_order: 'tools/lookup.ts' } })
    write(repo, 'tools/lookup.ts', 'export default {}\n')
    write(repo, 'tools/lib/client.ts', 'export const v = 1\n')
    write(repo, `${DIR}/opencode.json`, '{}\n')
    const one = buildRelease(repo, commitAll(repo, 'tools'), DIR, { projectId: 'proj-1', governance: withTools('one') })
    serveRelease(api, one)
    const { releases } = create()
    await releases.boot()
    expect(releases.projectRoot()).toBe(releaseDir(root, one.descriptor.release_id!))
    const runtime = fakeRuntime()

    write(repo, 'README.md', 'unrelated\n')
    const two = buildRelease(repo, commitAll(repo, 'readme'), DIR, { projectId: 'proj-1', governance: withTools('one') })
    serveRelease(api, two)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 0 })

    // A helper beside the module is part of the tool.
    write(repo, 'tools/lib/client.ts', 'export const v = 2\n')
    const three = buildRelease(repo, commitAll(repo, 'tool helper'), DIR, { projectId: 'proj-1', governance: withTools('one') })
    serveRelease(api, three)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 1 })

    // So is the declaration itself.
    write(repo, 'README.md', 'still unrelated\n')
    const four = buildRelease(repo, commitAll(repo, 'no tools'), DIR, { projectId: 'proj-1', governance: governance('one') })
    serveRelease(api, four)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 2 })
  })

  test('a change to the Kortix tool list restarts the runtime; the same list reconfigures', async () => {
    const withKortix = (prompt: string, kortixTools?: string[]) =>
      JSON.stringify({ ...JSON.parse(governance(prompt)), ...(kortixTools ? { kortix_tools: kortixTools } : {}) })
    const all = ['web_search', 'image_search', 'scrape_webpage', 'memory', 'show']
    write(repo, 'README.md', 'all five\n')
    const one = buildRelease(repo, commitAll(repo, 'all five'), DIR, { projectId: 'proj-1', governance: withKortix('one', all) })
    serveRelease(api, one)
    const { releases } = create()
    await releases.boot()
    const runtime = fakeRuntime()

    write(repo, 'README.md', 'prompt only\n')
    const two = buildRelease(repo, commitAll(repo, 'prompt only'), DIR, { projectId: 'proj-1', governance: withKortix('two', all) })
    serveRelease(api, two)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 0 })

    write(repo, 'README.md', 'show removed\n')
    const three = buildRelease(repo, commitAll(repo, 'no show'), DIR, { projectId: 'proj-1', governance: withKortix('two', all.slice(0, 4)) })
    serveRelease(api, three)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 1 })

    // No list (a config compiled without a `tools` key) is a change too: every Kortix tool loads again.
    write(repo, 'README.md', 'tools key removed\n')
    const four = buildRelease(repo, commitAll(repo, 'no tools key'), DIR, { projectId: 'proj-1', governance: withKortix('two') })
    serveRelease(api, four)
    expect((await releases.converge(runtime)).outcome).toBe('applied')
    expect(runtime.state).toMatchObject({ reconfigures: 1, restarts: 2 })
  })

  test('a release without a pi config dir leaves pi none; with releases off pi resolves the working tree', async () => {
    serveRelease(api, release('deploy', 'from release one'))
    const on = create()
    await on.releases.boot()
    expect(on.releases.piConfigDir()).toBeNull()

    api.respond(FEATURE_DISABLED)
    const off = create()
    await off.releases.boot()
    expect(off.releases.piConfigDir()).toBeUndefined()
  })

  test('no runtime yet: nothing to apply, and it says so', async () => {
    serveRelease(api, release('deploy', 'from release one'))
    const { releases } = create()
    const result = await releases.converge(null)
    expect(result).toMatchObject({ ok: false, outcome: 'failed', reason: 'the pi runtime is not running; nothing to apply' })
  })
})

describe('pi config releases: the compiled governance belongs to the release', () => {
  const GOV_TOKEN = 'pi-governance-authority-token-32ch'
  const PUSHED = '{"agent":{"build":{"prompt":"from an env push"}}}'

  function envApp(releases: Pick<PiConfigReleases, 'governanceOwned' | 'inFlight' | 'converge'>) {
    const cfg = { sandboxToken: GOV_TOKEN, workspace: tmp, projectTarget: tmp, defaultBranch: 'main' } as unknown as Config
    const store = createProjectEnvStore({ KORTIX_PROJECT_SECRETS_REVISION: 'rev-1', KORTIX_PROJECT_SECRET_NAMES: '' } as NodeJS.ProcessEnv)
    const control = createPiControlService(() => null, releases as PiConfigReleases, () => undefined).bind({
      cfg,
      projectEnv: store,
      agentEnvFile: join(tmp, 'agent-env.sh'),
    })
    return new Hono().route('/kortix/env', createEnvRouter(cfg, control))
  }

  const push = (target: Hono) =>
    target.request('/kortix/env', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GOV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 'rev-1',
        env: {},
        names: [],
        runtimeEnv: { KORTIX_COMPILED_AGENT_CONFIG: PUSHED, KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'ffffffffffffffff' },
        refreshModels: true,
      }),
    })

  const saved = { config: process.env.KORTIX_COMPILED_AGENT_CONFIG, etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG }
  afterEach(() => {
    for (const [name, value] of [
      ['KORTIX_COMPILED_AGENT_CONFIG', saved.config],
      ['KORTIX_COMPILED_AGENT_CONFIG_ETAG', saved.etag],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test('a /kortix/env push of the governance is dropped while a release owns it', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = governance('from the release')
    const res = await push(envApp({ governanceOwned: () => true, inFlight: () => false, converge: async () => { throw new Error('unused') } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runtime_env_changed: boolean; runtime_env_names: string[] }
    expect(body.runtime_env_changed).toBe(false)
    expect(body.runtime_env_names).toEqual([])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(governance('from the release'))
  })

  test('without a release the push applies, as it always did', async () => {
    const res = await push(envApp({ governanceOwned: () => false, inFlight: () => false, converge: async () => { throw new Error('unused') } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runtime_env_names: string[] }
    expect(body.runtime_env_names).toEqual(['KORTIX_COMPILED_AGENT_CONFIG', 'KORTIX_COMPILED_AGENT_CONFIG_ETAG'])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(PUSHED)
  })
})
