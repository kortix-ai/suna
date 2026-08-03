/**
 * `KORTIX_COMPILED_AGENT_CONFIG` must be accepted on the live-env route.
 *
 * It is the server-compiled agent config — agents, prompts, permissions, model.
 * It was the one piece of a session's configuration with no way into a running
 * box: compiled from git at provision, handed down as an env var, and excluded
 * from this allowlist. A `git pull` in the sandbox changed the working tree but
 * not the agent's behaviour, and restarting opencode re-read the daemon's
 * unchanged env and rebuilt the same stale config — so the only way to pick up a
 * merged agent change was a brand-new session.
 *
 * opencode composes its config from this env at spawn and never re-reads it, so
 * accepting the value is only half the job — the restart is what applies it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_ROUTE = readFileSync(join(import.meta.dir, '..', 'routes', 'env.ts'), 'utf8')

/** The allowlist body, so a name added to a comment or another Set never counts. */
function runtimeEnvAllowlist(): string[] {
  const body = ENV_ROUTE.split('const OPENCODE_RUNTIME_ENV_NAMES = new Set([')[1]?.split('])')[0]
  expect(body).toBeTruthy()
  return [...(body as string).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string)
}

describe('the live-env allowlist', () => {
  test('accepts the compiled agent config', () => {
    expect(runtimeEnvAllowlist()).toContain('KORTIX_COMPILED_AGENT_CONFIG')
  })

  test('still accepts the model — the precedent this follows', () => {
    // A mid-session model change already worked exactly this way: allowlist the
    // name, then restart. If that stopped being true, the reload built on top of
    // it is standing on nothing.
    expect(runtimeEnvAllowlist()).toContain('KORTIX_OPENCODE_MODEL')
  })

  test('the allowlist is a closed set, not a pattern over KORTIX_*', () => {
    // Anything reaching opencode's process env is reaching the agent. The gate
    // is an explicit list precisely so a new KORTIX_* name cannot be pushed into
    // a running box by accident.
    expect(ENV_ROUTE).toContain('if (!OPENCODE_RUNTIME_ENV_NAMES.has(name)) continue')
    expect(runtimeEnvAllowlist().length).toBeLessThan(10)
  })

  test('an allowlisted change with refreshModels restarts opencode', () => {
    // Accepting the value alone changes nothing: opencode reads its config only
    // at spawn. Without this the push would silently no-op until the next boot.
    expect(ENV_ROUTE).toContain('await opencode.restart()')
    expect(ENV_ROUTE).toContain(
      'if (body.refreshModels === true && (result.changed || opencodeEnvChanged))',
    )
  })
})

const OPENCODE_SRC = readFileSync(join(import.meta.dir, '..', 'opencode.ts'), 'utf8')

describe('the unplanned-respawn hook waits for readiness', () => {
  test('it fires only after opencode answers again, not when the process spawns', () => {
    // `spawnChild` resolving means the PROCESS started; opencode's HTTP server
    // comes up seconds later. Firing the hook on spawn had it call `/message`
    // against a dead port, read the failure as "no turn to finalize", and do
    // nothing at all — silently failing in exactly the case it exists for.
    const respawn = OPENCODE_SRC.split('function scheduleUnplannedRespawn(')[1]?.split('\n  }\n')[0]
    expect(respawn).toBeTruthy()
    expect(respawn).toContain('waitUntilReady(')
    // The hook must be INSIDE the readiness continuation, not beside it.
    const hookAt = (respawn as string).indexOf('options.onUnplannedRespawn?.()')
    const waitAt = (respawn as string).indexOf('waitUntilReady(')
    expect(waitAt).toBeGreaterThanOrEqual(0)
    expect(hookAt).toBeGreaterThan(waitAt)
  })

  test('the wait is bounded, so cleanup cannot outlive the problem', () => {
    expect(OPENCODE_SRC).toContain('const RESPAWN_FINALIZE_TIMEOUT_MS =')
    expect(OPENCODE_SRC).toContain('if (!ready) {')
  })

  test('a planned stop/restart never reaches the hook', () => {
    // Those return early with `stopping` set; their callers own the turn.
    // The full signature — a comment upstream also mentions `proc.on('exit')`,
    // and splitting on that matched the prose instead of the handler.
    const exitHandler = OPENCODE_SRC.split("proc.on('exit', (code, signal) =>")[1]?.split(
      "proc.on('error'",
    )[0]
    expect(exitHandler).toContain('if (stopping) return')
    // The respawn (and with it the hook) is only reached past that guard.
    expect((exitHandler as string).indexOf('if (stopping) return')).toBeLessThan(
      (exitHandler as string).indexOf('scheduleUnplannedRespawn()'),
    )
  })

  test('a respawn that fails to spawn cannot take the daemon down', () => {
    // `spawnChild` writes the config before spawning, so it can reject on a full
    // or read-only disk. Unhandled that would kill the daemon — the only thing
    // that can bring opencode back.
    const respawn = OPENCODE_SRC.split('function scheduleUnplannedRespawn(')[1]?.split('\n  }\n')[0]
    expect(respawn).toContain('.catch(')
    // And it must RETRY: a failed spawn produces no process, so no exit event —
    // relying on that to retry would leave opencode down permanently.
    expect(respawn).toContain('scheduleUnplannedRespawn()')
  })
})
