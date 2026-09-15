import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Shape assertions over the boot sequence (a unit suite cannot boot OpenCode).
// They keep the sub-marks that decompose `opencode-ready` — and the early
// initial-turn claim — from being quietly dropped.
const MAIN = readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')
const OPENCODE = readFileSync(join(import.meta.dir, '..', 'opencode.ts'), 'utf8')

describe('boot instrumentation', () => {
  test('the initial-turn claim is prefetched at proxy-up, before the clone is awaited', () => {
    const proxyUp = MAIN.indexOf("bootMark('proxy-up')")
    const earlyClaim = MAIN.indexOf('void claimInitialTurnFromApi()', proxyUp)
    const repoAwait = MAIN.indexOf('await repoMaterializePromise', proxyUp)
    expect(proxyUp).toBeGreaterThan(-1)
    expect(earlyClaim).toBeGreaterThan(proxyUp)
    expect(repoAwait).toBeGreaterThan(earlyClaim)
  })

  test('every stage of the initial-session path has its own mark, in order', () => {
    const start = MAIN.indexOf('async function maybeCreateInitialOpencodeSession')
    const order = [
      "bootMark('initial-turn-claimed')",
      "bootMark('opencode-answering')",
      "bootMark('opencode-root-created')",
      "bootMark('opencode-root-ready')",
      "bootMark('initial-prompt-delivered')",
    ]
    let cursor = start
    for (const mark of order) {
      const at = MAIN.indexOf(mark, cursor)
      expect(at, mark).toBeGreaterThan(cursor)
      cursor = at
    }
    const finalize = MAIN.indexOf('const completeInitialSessionBoot = async () => {')
    const accepted = MAIN.indexOf("bootMark('initial-turn-accepted')", finalize)
    const ready = MAIN.indexOf("bootMark('opencode-ready')", finalize)
    expect(finalize).toBeGreaterThan(-1)
    expect(accepted).toBeGreaterThan(finalize)
    expect(ready).toBeGreaterThan(accepted)
  })

  test('the directory-scoped probe stays closed until the workspace is ready', () => {
    // OpenCode builds a directory Instance — and reads that directory's
    // node_modules for local tools — on the FIRST directory-scoped request,
    // and keeps that registry for the life of the process. With the early
    // spawn our own 100 ms readiness probe is that first request, so it must
    // not be directory-scoped until the checkout + deps are in place.
    expect(OPENCODE).toContain('deferDirectoryProbe?: boolean')
    expect(OPENCODE).toContain('async function probeOpencodeListening(')
    expect(OPENCODE).toContain('/kortix-liveness-probe')
    const check = OPENCODE.indexOf('async function checkReady(')
    expect(OPENCODE.slice(check, check + 220)).toContain('if (!directoryProbeOpen) return false')

    // main.ts: gate requested exactly when the early spawn can happen, and
    // opened only after config deps + injected skills.
    expect(MAIN).toContain('deferDirectoryProbe: cfg.autoClone && resolveHintedOpencodeConfigDir(cfg) !== null')
    const deps = MAIN.indexOf("bootMark('config-deps')")
    const open = MAIN.indexOf('opencode.markWorkspaceReady()', deps)
    const reload = MAIN.indexOf('opencode.reloadForWorkspace()', open)
    expect(deps).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(deps)
    expect(reload).toBeGreaterThan(open)
  })

  test('the proxy holds every caller off until the workspace is complete', () => {
    const PROXY = readFileSync(join(import.meta.dir, '..', 'proxy.ts'), 'utf8')
    expect(PROXY).toContain("bootState.workspaceReady === false")
    expect(PROXY).toContain("'workspace_not_ready'")
    // set false only on the early-spawn path, true once deps + skills are in
    expect(MAIN).toContain('if (earlyOpencodeConfigDir) bootState.workspaceReady = false')
    // The gate must open where the workspace is COMPLETE — after the deps and
    // the injected skills — and never inside the early-spawn block. An earlier
    // revision opened it right after start(), which made the whole fix inert
    // (verified on dev: the log showed the gate opening at ~130 ms, before the
    // checkout landed at ~300 ms). Anchor on the LAST reconfigure, not on a
    // bare indexOf that a later duplicate can satisfy.
    const earlySpawn = MAIN.indexOf('const earlyOpencodeStartPromise')
    const earlySpawnEnd = MAIN.indexOf('const compiledOpencodeConfigDir', earlySpawn)
    expect(MAIN.slice(earlySpawn, earlySpawnEnd)).not.toContain('markWorkspaceReady')

    const deps = MAIN.indexOf('await ensureOpencodeConfigDeps(opencodeConfigDir)')
    const skills = MAIN.indexOf('await ensureInjectedManagedSkills(opencodeConfigDir)', deps)
    const reconfigure = MAIN.indexOf('opencode.reconfigure(cfg, opencodeConfigDir, projectEnv)', skills)
    const open = MAIN.indexOf('opencode.markWorkspaceReady()', reconfigure)
    const reload = MAIN.indexOf('opencode.reloadForWorkspace()', open)
    expect(deps).toBeGreaterThan(-1)
    expect(skills).toBeGreaterThan(deps)
    expect(open).toBeGreaterThan(reconfigure)
    expect(reload).toBeGreaterThan(open)
  })

  test('an instance that answered before the workspace was ready forces a restart, not a dispose', () => {
    const fn = OPENCODE.indexOf('async reloadForWorkspace()')
    const body = OPENCODE.slice(fn, OPENCODE.indexOf('async reloadConfig(', fn))
    expect(body).toContain('restarting instead of disposing')
    expect(body).not.toContain('return disposeInstances()')
    const restart = MAIN.indexOf('opencode.restart()', MAIN.indexOf('const reloaded = await opencode.reloadForWorkspace()'))
    expect(restart).toBeGreaterThan(-1)
  })

  test('the supervisor reports the first HTTP response separately from the first 200', () => {
    expect(OPENCODE).toContain('onFirstListeningResponse?: () => void')
    const probe = OPENCODE.indexOf('const probe = directoryProbeOpen')
    const report = OPENCODE.indexOf('options.onFirstListeningResponse?.()', probe)
    expect(probe).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(probe)
    expect(MAIN).toContain("bootMark('opencode-http-listening')")
  })
})
