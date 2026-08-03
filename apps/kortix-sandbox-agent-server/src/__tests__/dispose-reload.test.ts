/**
 * The measured facts `tryDisposeReload` is built on.
 *
 * All three were established on 2026-08-03 by running the pinned opencode
 * (opencode-ai@1.17.11, the exact build the sandbox image installs) locally and
 * probing it:
 *
 *   1. `POST /global/dispose` re-reads the config FILE from disk, in-process —
 *      same pid, ~51ms. A respawn is ~8s.
 *   2. There is NO config file watcher. A fresh process left with an edited
 *      config on disk for 18s served the boot config unchanged; every edit
 *      needs its own dispose.
 *   3. `POST /kortix/services/system/reload` — which the SDK's `systemReload()`
 *      and the web "Restart: Config Only" palette entry call — does NOT exist.
 *      It falls through to opencode's SPA catch-all and answers 200 with
 *      `text/html`.
 *
 * (3) is why the content-type check below is load-bearing rather than
 * defensive: a 200 from that server does not mean the endpoint ran.
 *
 * These are assertions about OUR code's shape, not a live opencode — a unit
 * suite cannot boot a 129MB binary. They exist so the reasoning above cannot be
 * quietly undone; if opencode's behaviour changes, re-run the probe.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const OPENCODE_SRC = readFileSync(join(import.meta.dir, '..', 'opencode.ts'), 'utf8')

function disposeReloadBody(): string {
  const body = OPENCODE_SRC.split('async function tryDisposeReload(')[1]?.split('\n  }\n')[0]
  expect(body).toBeTruthy()
  return body as string
}

describe('tryDisposeReload', () => {
  test('rewrites the config file BEFORE asking opencode to re-read it', () => {
    // Dispose re-reads from disk. Calling it without rewriting first would
    // re-read the same bytes and apply nothing.
    const body = disposeReloadBody()
    const wrote = body.indexOf('writeKortixOpencodeConfig(')
    const disposed = body.indexOf('/global/dispose')
    expect(wrote).toBeGreaterThanOrEqual(0)
    expect(disposed).toBeGreaterThan(wrote)
  })

  test('composes the config from the SAME env spawnChild uses', () => {
    // If the two diverged, a dispose and a respawn would apply different
    // configs and the difference would only show on the next reboot.
    expect(disposeReloadBody()).toContain('mergeProjectEnv(process.env, currentProjectEnv)')
    expect(OPENCODE_SRC).toContain('const baseEnv = currentProjectEnv')
  })

  test('a 200 alone is NOT success — content-type AND body are checked', () => {
    // opencode answers 200 text/html for every unknown path (its SPA
    // catch-all), which is exactly how the SDK's systemReload() is broken.
    // And the endpoint answers `true`: a JSON `false` with a 200 would
    // otherwise be read as "reloaded" and skip the fallback, leaving the old
    // config running while we reported success.
    const body = disposeReloadBody()
    expect(body).toContain("includes('application/json')")
    expect(body).toContain('body === true')
  })

  test('it reports failure rather than throwing, so the caller can fall back', () => {
    const body = disposeReloadBody()
    expect(body).toContain('return false')
    expect(body).toContain('catch')
  })

  test('a deny-list change forces a respawn — dispose cannot re-run env shaping', () => {
    // KORTIX_OPENCODE_DENY_ENV is not IN the config file. `withoutDeniedProviderEnv`
    // strips native provider keys when the child is SPAWNED, so disposing after a
    // gateway-mode toggle leaves those keys exactly as they were — routing around
    // the gateway's budgets and logging, or failing to restore BYOK.
    const ENV_ROUTE = readFileSync(join(import.meta.dir, '..', 'routes', 'env.ts'), 'utf8')
    expect(ENV_ROUTE).toContain("opencodeEnvNames.includes('KORTIX_OPENCODE_DENY_ENV')")
    expect(ENV_ROUTE).toContain('reloadConfig({ mustRespawn })')
    // And the supervisor must honour it BEFORE trying dispose.
    const reload = OPENCODE_SRC.split('async reloadConfig(')[1]?.split('\n    },')[0]
    expect(reload).toContain('!opts.mustRespawn && (await tryDisposeReload())')
  })

  test('reloadConfig falls back to a full restart when dispose does not win', () => {
    // A future opencode that drops the endpoint must degrade to today's
    // behaviour, never to "config silently not applied".
    const reload = OPENCODE_SRC.split('async reloadConfig(')[1]?.split('\n    },')[0]
    expect(reload).toBeTruthy()
    expect(reload).toContain('tryDisposeReload()')
    expect(reload).toContain('this.restart()')
    const disposeAt = (reload as string).indexOf('tryDisposeReload()')
    const restartAt = (reload as string).indexOf('this.restart()')
    expect(disposeAt).toBeLessThan(restartAt)
  })
})
