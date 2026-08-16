/**
 * T1: the orphan finalizer must be idempotent across repeated
 * boots/respawns over the SAME stuck turn.
 *
 * `inspectRoot` used to decide "orphaned" solely on
 * `role === 'assistant' && !time.completed`. It never read `info.error`. So if
 * a prior `/abort` stamped an error (AbortError/MessageAbortedError) without
 * ever stamping `time.completed` — which is exactly what a real opencode
 * `/abort` does — every later boot or unplanned respawn saw the same
 * "incomplete assistant turn" shape and aborted it again. Each re-abort
 * re-emits `message.updated`/`session.error` to every client watching,
 * re-rendering the "Interrupted" marker on a turn that was already closed out.
 *
 * `finalizeOrphanedTurn` is the shared entry point behind BOTH the unplanned-
 * respawn hook (main.ts's `onUnplannedRespawn`, called via
 * `opencode.ts`'s `finalizeAfterReplacement`) and structurally the same guard
 * the boot reused-root path applies inline in `maybeCreateInitialOpencodeSession`
 * — both route through the same `isTurnStillOrphaned` predicate. Exercising it
 * here covers the predicate itself, which is what every finalize path shares.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { finalizeOrphanedTurn } from '../main'

const SRC = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()

const servers: Array<{ stop(closeActive?: boolean): void }> = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

/**
 * A minimal stand-in for opencode's `/session/:id/message` + `/session/:id/abort`.
 * Mirrors the real contract this bug depends on: an `/abort` call stamps
 * `info.error` on the last message but never sets `time.completed` — so the
 * "incomplete assistant turn" shape persists across the abort. Real opencode
 * behavior, not a test artifact: `time.completed` is set only by the agent
 * loop finishing the turn normally, not by aborting it.
 */
function orphanServer(opts: { startsWithError?: boolean } = {}) {
  let abortCount = 0
  let hasError = Boolean(opts.startsWithError)
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname.endsWith('/message')) {
        return Response.json([
          { info: { id: 'msg_user', role: 'user', time: { completed: 1 } } },
          {
            info: {
              id: 'msg_assistant',
              role: 'assistant',
              time: {},
              ...(hasError ? { error: { name: 'MessageAbortedError', message: 'aborted' } } : {}),
            },
          },
        ])
      }
      if (req.method === 'POST' && url.pathname.endsWith('/abort')) {
        abortCount++
        hasError = true
        return new Response('{}', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { port: server.port as number, abortCount: () => abortCount }
}

describe('finalizeOrphanedTurn — idempotent across repeated boots/respawns', () => {
  test('a turn already carrying an error is never re-aborted on a second boot: exactly one /abort total', async () => {
    const { port, abortCount } = orphanServer()
    const baseUrl = `http://127.0.0.1:${port}`

    // "Boot 1": genuinely orphaned — incomplete, no error yet. Gets aborted,
    // which (per the real opencode contract mirrored above) stamps info.error
    // without ever stamping time.completed.
    const firstBoot = await finalizeOrphanedTurn(baseUrl, '/workspace', 'ses_abc')
    expect(firstBoot).toBe(true)
    expect(abortCount()).toBe(1)

    // "Boot 2" (or an unplanned respawn) over the SAME still-incomplete turn.
    // It now carries the error the first abort stamped. Zero additional
    // /abort calls — this is the exact repeated-"Interrupted" bug.
    const secondBoot = await finalizeOrphanedTurn(baseUrl, '/workspace', 'ses_abc')
    expect(secondBoot).toBe(false)
    expect(abortCount()).toBe(1)
  }, 15_000)

  test('a turn that already carries an error from the start is never aborted', async () => {
    // Covers the boot path directly: the daemon comes up fresh (no prior call
    // in this process) and finds a turn some earlier process already errored.
    const { port, abortCount } = orphanServer({ startsWithError: true })
    const baseUrl = `http://127.0.0.1:${port}`

    expect(await finalizeOrphanedTurn(baseUrl, '/workspace', 'ses_pre_errored')).toBe(false)
    expect(abortCount()).toBe(0)
  }, 15_000)

  test('a genuinely orphaned turn with no error is still aborted, same as before', async () => {
    const { port, abortCount } = orphanServer()
    const baseUrl = `http://127.0.0.1:${port}`

    expect(await finalizeOrphanedTurn(baseUrl, '/workspace', 'ses_xyz')).toBe(true)
    expect(abortCount()).toBe(1)
  }, 15_000)
})

describe('the guard is shared, not duplicated per call site', () => {
  test('inspectRoot reports lastTurnHasError from info.error', () => {
    const start = SRC.indexOf('async function inspectRoot(')
    expect(start).toBeGreaterThan(-1)
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start))
    expect(body).toContain('lastTurnHasError')
    expect(body).toContain('last?.info?.error')
  })

  test('finalizeOrphanedTurn routes through the shared isTurnStillOrphaned predicate', () => {
    const start = SRC.indexOf('export async function finalizeOrphanedTurn(')
    expect(start).toBeGreaterThan(-1)
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start))
    expect(body).toContain('isTurnStillOrphaned(inspection)')
  })

  test('the boot reused-root path routes through the same predicate', () => {
    const start = SRC.indexOf('async function maybeCreateInitialOpencodeSession(')
    expect(start).toBeGreaterThan(-1)
    const body = SRC.slice(start, SRC.indexOf('\nasync function resolveExistingRoot', start))
    expect(body).toContain('isTurnStillOrphaned(existing)')
  })
})
