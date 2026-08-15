/**
 * T12: the daemon must never replay `KORTIX_INITIAL_PROMPT` into a
 * conversation that already has it, and must never orphan a pinned root by
 * creating a competing one.
 *
 * Two holes, both traced back to the same root cause — a failed read
 * collapsing into "there is nothing here":
 *
 *   1. `inspectRoot` used to fold every read failure (non-2xx, the 5s
 *      `AbortSignal.timeout`, an unparseable body) into `hasMessages: false`.
 *      That reads as "no prompt was ever delivered", so boot's reused-root
 *      path re-delivers `prompt` into a conversation that already has it —
 *      and, separately, could re-run the orphan-abort against a turn it never
 *      actually confirmed was dead. `RootInspection.known` (this file) and
 *      `initialPromptAlreadyDelivered`/`isTurnStillOrphaned` close both: an
 *      unconfirmed read never delivers and never counts as orphaned.
 *   2. `waitForRootList` returning null after its deadline (opencode never
 *      answered) used to fall through to "no roots" — the same as a genuinely
 *      empty workspace — so `resolveExistingRoot` created (and pinned) a
 *      BRAND NEW root even though a prior root was already pinned, orphaning
 *      it. `resolveExistingRoot`'s `defer` outcome closes this: a timeout
 *      with a prior pin creates nothing.
 *
 * Covers both hazards directly against `resolveExistingRoot` (real HTTP,
 * fake opencode) plus the pure gates it feeds (`initialPromptAlreadyDelivered`,
 * `isTurnStillOrphaned` via `finalizeOrphanedTurn`) — the same mix of
 * behavioral + source-text assertions this file's siblings
 * (never-abort-live-turn.test.ts, orphan-finalize-error-idempotent.test.ts)
 * already use for these exact call sites.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  finalizeOrphanedTurn,
  initialPromptAlreadyDelivered,
  resolveExistingRoot,
  reusedRootAlreadyDelivered,
} from '../main'

const SRC = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()

const servers: Array<{ stop(closeActive?: boolean): void }> = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

/** A minimal stand-in for opencode's `/session` (root list) +
 *  `/session/:id/message` (this test only ever asks about one root, so the id
 *  in the path is ignored). */
function rootServer(opts: {
  roots?: Array<{ id: string; created?: number; updated?: number }>
  /** HTTP status the message-list read returns. 200 with `messages`, or a
   *  non-2xx to simulate the read failing. */
  messageStatus?: number
  messages?: Array<{ info?: { id?: string; role?: string; error?: unknown; time?: { completed?: number } } }>
  /** Never answer `/session` at all — simulates opencode not listening yet
   *  (the `waitForRootList` timeout hazard). */
  hangRootList?: boolean
}) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && /\/session$/.test(url.pathname)) {
        if (opts.hangRootList) return new Response('not ready', { status: 503 })
        return Response.json(
          (opts.roots ?? []).map((r) => ({
            id: r.id,
            time: { created: r.created ?? 1, updated: r.updated ?? r.created ?? 1 },
          })),
        )
      }
      if (req.method === 'GET' && url.pathname.endsWith('/message')) {
        if (opts.messageStatus && opts.messageStatus !== 200) {
          return new Response('unhappy', { status: opts.messageStatus })
        }
        return Response.json(opts.messages ?? [])
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { port: server.port as number }
}

describe('resolveExistingRoot — tri-state message read (hole 1)', () => {
  test('message-list read times out (non-2xx): known=false, hasMessages=false', async () => {
    const { port } = rootServer({
      roots: [{ id: 'ses_root' }],
      messageStatus: 500,
    })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', null)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.root.known).toBe(false)
    expect(result.root.hasMessages).toBe(false)
  })

  test('read succeeds with messages: known=true, hasMessages=true (unchanged)', async () => {
    const { port } = rootServer({
      roots: [{ id: 'ses_root' }],
      messages: [{ info: { id: 'msg_1', role: 'user', time: { completed: 1 } } }],
    })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', null)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.root.known).toBe(true)
    expect(result.root.hasMessages).toBe(true)
  })

  test('truly empty root: known=true, hasMessages=false (unchanged)', async () => {
    const { port } = rootServer({
      roots: [{ id: 'ses_root' }],
      messages: [],
    })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', null)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.root.known).toBe(true)
    expect(result.root.hasMessages).toBe(false)
  })
})

describe('initialPromptAlreadyDelivered — the delivery gate fed by known (hole 1, delivery half)', () => {
  test('unknown read: never deliver (treated as already delivered)', () => {
    expect(initialPromptAlreadyDelivered({ known: false, hasMessages: false })).toBe(true)
  })

  test('known + has messages: already delivered, no re-run', () => {
    expect(initialPromptAlreadyDelivered({ known: true, hasMessages: true })).toBe(true)
  })

  test('known + empty: not yet delivered, deliver now', () => {
    expect(initialPromptAlreadyDelivered({ known: true, hasMessages: false })).toBe(false)
  })
})

describe('finalizeOrphanedTurn — the abort gate fed by known (hole 1, orphan half)', () => {
  test('message-list read fails: zero aborts, turn never treated as orphaned', async () => {
    const { port } = rootServer({ messageStatus: 500 })
    const baseUrl = `http://127.0.0.1:${port}`

    const aborted = await finalizeOrphanedTurn(baseUrl, '/workspace', 'ses_unreadable')
    expect(aborted).toBe(false)
  })
})

describe('resolveExistingRoot — waitForRootList timeout (hole 2)', () => {
  test('timeout WITH a prior pin: defers, creates nothing', async () => {
    // `/session` never answers 200, so `waitForRootList` never gets a
    // definitive list and hits its deadline. A short deadline keeps this test
    // fast; production uses 20s (the default param) for the real one.
    const { port } = rootServer({ hangRootList: true })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', 'ses_prior_pin', 300)
    expect(result.status).toBe('defer')
  })

  test('timeout WITHOUT a prior pin: still safe to create (pinless cold boot, unchanged)', async () => {
    const { port } = rootServer({ hangRootList: true })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', null, 300)
    expect(result.status).toBe('create')
  })

  test('reachable but genuinely empty: still safe to create, not deferred', async () => {
    const { port } = rootServer({ roots: [] })
    const baseUrl = `http://127.0.0.1:${port}`

    const result = await resolveExistingRoot(baseUrl, '/workspace', 'ses_prior_pin', 300)
    expect(result.status).toBe('create')
  })
})

describe('the boot path is wired to the defer outcome, not just resolveExistingRoot', () => {
  test('maybeCreateInitialOpencodeSession returns before creating or pinning a session on defer', () => {
    const start = SRC.indexOf('async function maybeCreateInitialOpencodeSession(')
    expect(start).toBeGreaterThan(-1)
    const deferAt = SRC.indexOf("resolved.status === 'defer'", start)
    expect(deferAt).toBeGreaterThan(start)
    const returnAt = SRC.indexOf('return', deferAt)
    const createCallAt = SRC.indexOf('createInitialOpenCodeSession(', start)
    const pinCallAt = SRC.indexOf('pinOpencodeSessionFile(', start)
    // The defer branch's `return` must come before ANY create/pin call in the
    // function — not just textually near the branch, but strictly ahead of
    // both, so a deferred boot really does touch neither.
    expect(returnAt).toBeGreaterThan(deferAt)
    expect(returnAt).toBeLessThan(createCallAt)
    expect(returnAt).toBeLessThan(pinCallAt)
  })

  test('delivery is gated through reusedRootAlreadyDelivered, not a raw hasMessages read', () => {
    const start = SRC.indexOf('async function maybeCreateInitialOpencodeSession(')
    const end = SRC.indexOf('\nasync function resolveExistingRoot', start)
    const body = SRC.slice(start, end)
    expect(body).toContain('alreadyDelivered = reusedRootAlreadyDelivered(existing, priorPin)')
    // T22: `priorPin` must be captured BEFORE `resolveExistingRoot` runs, so it
    // reflects only what a PRIOR boot pinned — never this boot's own pending
    // write (see `pinOpencodeSessionFile` further down the same function).
    const priorPinReadAt = body.indexOf('const priorPin = readPinnedOpencodeSessionId()')
    const resolveCallAt = body.indexOf('await resolveExistingRoot(')
    const pinWriteAt = body.indexOf('pinOpencodeSessionFile(')
    expect(priorPinReadAt).toBeGreaterThan(-1)
    expect(priorPinReadAt).toBeLessThan(resolveCallAt)
    expect(priorPinReadAt).toBeLessThan(pinWriteAt)
  })
})

describe('reusedRootAlreadyDelivered — the T22 staged-revert boot guard', () => {
  test('a prior pin overrides an empty (revert-truncated) transcript', () => {
    // Same shape a committed revert leaves behind: the read succeeded
    // (`known: true`) but found zero messages — exactly what
    // `initialPromptAlreadyDelivered` alone would read as "never delivered".
    expect(reusedRootAlreadyDelivered({ known: true, hasMessages: false }, 'ses_prior_pin')).toBe(
      true,
    )
  })

  test('a prior pin overrides an unreadable transcript too', () => {
    expect(reusedRootAlreadyDelivered({ known: false, hasMessages: false }, 'ses_prior_pin')).toBe(
      true,
    )
  })

  test('pinless + has messages: still delivered (unchanged from T12)', () => {
    expect(reusedRootAlreadyDelivered({ known: true, hasMessages: true }, null)).toBe(true)
  })

  test('pinless + genuinely empty: not yet delivered, deliver now (unchanged from T12)', () => {
    expect(reusedRootAlreadyDelivered({ known: true, hasMessages: false }, null)).toBe(false)
  })
})
