/**
 * The measured facts `tryDisposeReload` is built on.
 *
 * All three were established on 2026-08-03 against opencode-ai@1.17.11 and
 * re-probed on 2026-08-20 against opencode-ai@1.18.19 (the exact build the
 * sandbox image installs) locally:
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
    // Matched case-insensitively, not by substring: header values are
    // case-insensitive and `application/<vendor>+json` is JSON. A false
    // negative here would cost a needless ~8s respawn.
    expect(body).toContain('json')
    expect(body).toContain('/i.test(')
    expect(body).not.toContain("includes('application/json')")
    expect(body).toContain('body === true')
  })

  test('it reports failure rather than throwing, so the caller can fall back', () => {
    const body = disposeReloadBody()
    expect(body).toContain('return false')
    expect(body).toContain('catch')
  })

  test('the env route passes credential-carrier changes to the respawn gate', () => {
    const ENV_ROUTE = readFileSync(join(import.meta.dir, '..', 'routes', 'env.ts'), 'utf8')
    // The route used to inline `opencodeEnvNames.includes('KORTIX_OPENCODE_DENY_ENV')`.
    // The invariant is unchanged; the mechanism moved into `requiresRespawn`,
    // which also covers the auth carriers a dispose cannot rewrite — and keys
    // off the value DELTA rather than the full allowlist.
    expect(ENV_ROUTE).toContain('requiresRespawn(')
    expect(ENV_ROUTE).toContain('result.changedNames')
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
    // The fallback is now a VERIFIED swap rather than `this.restart()`: boot the
    // new opencode, prove it serves, then retire the old one, so a config that
    // cannot boot leaves the session on the instance it already had instead of
    // with nothing. The ordering guarantee below is unchanged — dispose is still
    // tried first, and the expensive path is still the fallback.
    expect(reload).toContain('reloadVerified()')
    const disposeAt = (reload as string).indexOf('tryDisposeReload()')
    const restartAt = (reload as string).indexOf('reloadVerified()')
    expect(disposeAt).toBeLessThan(restartAt)
  })
})

/**
 * Which env changes the dispose fast path is NOT allowed to handle.
 *
 * A dispose re-reads the opencode CONFIG FILE in place. It never re-runs
 * `spawnChild`, so everything spawn does with the env besides writing that file
 * survives untouched — including `materializeOpencodeAuth`, which writes
 * `~/.local/share/opencode/auth.json`.
 *
 * That made the fast path a credential bug. Connecting a ChatGPT/Codex account
 * changes `CODEX_AUTH_JSON`; before the fast path this route did a full
 * restart, which respawned and re-materialized. After it, the dispose left the
 * OLD auth.json on disk and opencode kept authenticating with the account the
 * user had just replaced — while the UI confirmed the new one.
 */
import { requiresRespawn, RESPAWN_REQUIRED_ENV_NAMES } from '../opencode'

describe('requiresRespawn', () => {
  test('the auth carriers force a respawn — a dispose cannot rewrite auth.json', () => {
    expect(requiresRespawn(['CODEX_AUTH_JSON'])).toBe(true)
    expect(requiresRespawn(['OPENCODE_AUTH_JSON'])).toBe(true)
  })

  test('an ordinary secret takes the fast path', () => {
    // ~51ms vs ~8s, and it does not sever an in-flight turn. Respawning for
    // every secret would make the fast path pointless.
    expect(requiresRespawn(['STRIPE_SECRET_KEY', 'DATABASE_URL'])).toBe(false)
    expect(requiresRespawn([])).toBe(false)
  })

  test('one carrier among many ordinary names still forces it', () => {
    expect(requiresRespawn(['STRIPE_SECRET_KEY', 'CODEX_AUTH_JSON', 'FOO'])).toBe(true)
  })

  test('every name spawnChild consumes outside the config file is listed', () => {
    // The guard against someone adding a third spawn-time consumer and only
    // discovering it when a user reports stale credentials.
    const SPAWN_SRC = OPENCODE_SRC.split('async function spawnChild(')[1]?.split('\n  }\n')[0] ?? ''
    expect(SPAWN_SRC).toContain('materializeOpencodeAuth(env)')
    expect([...RESPAWN_REQUIRED_ENV_NAMES].sort()).toEqual([
      'CODEX_AUTH_JSON',
      'KORTIX_SECRET_CAPABILITIES',
      'OPENCODE_AUTH_JSON',
    ])
  })
})
