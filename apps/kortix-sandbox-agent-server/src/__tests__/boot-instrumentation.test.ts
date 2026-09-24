import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Shape assertions over the boot sequence (a unit suite cannot boot OpenCode).
// They keep the sub-marks that decompose `opencode-ready` — and the early
// initial-turn claim — from being quietly dropped.
const MAIN = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8')
const OPENCODE = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'lifecycle.ts'), 'utf8')
const BOOT_PATH = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot-config-path.ts'), 'utf8')

describe('boot instrumentation', () => {
  test('the initial-turn claim is prefetched at proxy-up, before the clone is awaited', () => {
    const proxyUp = MAIN.indexOf("bootMark('proxy-up')")
    const earlyClaim = MAIN.indexOf('void claimInitialTurnFromApi()', proxyUp)
    // The clone is handed to the boot path as a promise; the boot path is what
    // awaits it. Nothing between proxy-up and that hand-off blocks on it.
    const cloneHandOff = MAIN.indexOf('workspace: repoMaterializePromise', proxyUp)
    expect(proxyUp).toBeGreaterThan(-1)
    expect(earlyClaim).toBeGreaterThan(proxyUp)
    expect(cloneHandOff).toBeGreaterThan(earlyClaim)
    expect(BOOT_PATH).toContain('const workspaceError = await input.workspace')
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

    // EVERY boot now spawns OpenCode before the config is decided, so the gate
    // is unconditionally closed and the one boot path is what opens it.
    expect(MAIN).toContain('deferDirectoryProbe: true')
    const chosen = BOOT_PATH.indexOf('// ── Step 7')
    const open = BOOT_PATH.indexOf('opencode.markWorkspaceReady()', chosen)
    const proof = BOOT_PATH.indexOf('const proof = await prove(')
    expect(proof).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(proof)
  })

  test('the proxy holds every caller off until the workspace is complete', () => {
    const PROXY = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'proxy.ts'), 'utf8')
    expect(PROXY).toContain("bootState.workspaceReady === false")
    expect(PROXY).toContain("'workspace_not_ready'")
    // Closed before the lifecycle exists, so no caller can slip through while
    // the config is still being decided.
    expect(MAIN).toContain('bootState.workspaceReady = false')
    const close = MAIN.indexOf('bootState.workspaceReady = false')
    expect(close).toBeLessThan(MAIN.indexOf('const harness = createOpenCodeHarnessService('))
    // The gate opens where the workspace is COMPLETE and the config is PROVEN,
    // never inside the spawn. An earlier revision opened it right after
    // start(), which made the whole fix inert (verified on dev: the gate opened
    // at ~130 ms, before the checkout landed at ~300 ms). `boot.ts` no longer
    // opens it at all — `boot-config-path.ts` does, once.
    expect(MAIN).not.toContain('markWorkspaceReady()')
    const workspace = BOOT_PATH.indexOf('const workspaceError = await input.workspace')
    const proof = BOOT_PATH.indexOf('const proof = await prove(', workspace)
    const open = BOOT_PATH.indexOf('opencode.markWorkspaceReady()', proof)
    expect(workspace).toBeGreaterThan(-1)
    expect(proof).toBeGreaterThan(workspace)
    expect(open).toBeGreaterThan(proof)
  })

  test('an instance that answered before the workspace was ready forces a restart, not a dispose', () => {
    const fn = OPENCODE.indexOf('async reloadForWorkspace()')
    const body = OPENCODE.slice(fn, OPENCODE.indexOf('async reloadConfig(', fn))
    expect(body).toContain('restarting instead of disposing')
    expect(body).not.toContain('return disposeInstances()')
    // The boot path asks for the in-place reload and respawns when it answers
    // false, so a dispose that is not enough still lands on a fresh process.
    expect(BOOT_PATH).toContain('if (index === 0 && (await input.refresh?.().catch(() => false)))')
    expect(BOOT_PATH).toContain('await input.respawn()')
  })

  test('the lifecycle reports the first HTTP response separately from the first 200', () => {
    expect(OPENCODE).toContain('onFirstListeningResponse?: () => void')
    const probe = OPENCODE.indexOf('const probe = directoryProbeOpen')
    const report = OPENCODE.indexOf('options.onFirstListeningResponse?.()', probe)
    expect(probe).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(probe)
    expect(MAIN).toContain("bootMark('opencode-http-listening')")
  })

  test('no boot-time request is sent before OpenCode announces its handler on stdout', () => {
    // OpenCode's port is bound ~100 ms before its request handler exists; a
    // request sent then is never answered. The lifecycle pipes stdout, waits
    // for `opencode server listening on`, and every boot-time caller — the
    // readiness probe, the root list, the /event subscribe — gates on it.
    expect(OPENCODE).toContain("const OPENCODE_LISTENING_LINE = 'opencode server listening on'")
    expect(OPENCODE).toContain("stdio: ['ignore', 'pipe', 'inherit']")
    expect(OPENCODE).toContain('waitForCurrentListening(): Promise<void>')
    expect(OPENCODE).toContain("startupMark('opencode-listening-line')")
    const gate = OPENCODE.indexOf('if (probedChild && !mayProbe(probedChild))')
    const probe = OPENCODE.indexOf('const probe = directoryProbeOpen', gate)
    expect(gate).toBeGreaterThan(-1)
    expect(probe).toBeGreaterThan(gate)
    expect(MAIN).toContain('firstListening: opencode.waitForCurrentListening()')
    const EVENTS = readFileSync(new URL('../harness/open-code/events.ts', import.meta.url), 'utf8')
    const wait = EVENTS.indexOf('await waitForListeningOrTimeout(opencode')
    const connect = EVENTS.indexOf('await connectOnce()', wait)
    expect(wait).toBeGreaterThan(-1)
    expect(connect).toBeGreaterThan(wait)
    expect(EVENTS).toContain("controller.abort(new DOMException('subscribe headers timeout', 'TimeoutError'))")
  })
})
