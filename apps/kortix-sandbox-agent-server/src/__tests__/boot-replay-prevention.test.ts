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
  test('the legacy path lets an in-flight request use its full attempt timeout', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'GET' && /\/session$/.test(new URL(req.url).pathname)) {
          await Bun.sleep(180)
          return Response.json([])
        }
        return new Response('not found', { status: 404 })
      },
    })
    servers.push(server)
    const startedAt = Date.now()

    const result = await resolveExistingRoot(
      `http://127.0.0.1:${server.port}`,
      '/workspace',
      'ses_prior_pin',
      50,
    )

    expect(result.status).toBe('create')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
  })

  test('an in-flight root request cannot extend the root-resolution deadline', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'GET' && /\/session$/.test(new URL(req.url).pathname)) {
          await Bun.sleep(1_000)
          return Response.json([])
        }
        return new Response('not found', { status: 404 })
      },
    })
    servers.push(server)
    const startedAt = Date.now()

    const result = await resolveExistingRoot(
      `http://127.0.0.1:${server.port}`,
      '/workspace',
      'ses_prior_pin',
      120,
      undefined,
      true,
    )

    expect(result.status).toBe('defer')
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  test('reports the first HTTP response once while OpenCode is still not ready', async () => {
    const { port } = rootServer({ hangRootList: true })
    const baseUrl = `http://127.0.0.1:${port}`
    const listeningMarks: string[] = []

    const result = await resolveExistingRoot(
      baseUrl,
      '/workspace',
      null,
      300,
      () => listeningMarks.push('listening'),
    )

    expect(result.status).toBe('create')
    expect(listeningMarks).toEqual(['listening'])
  })

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
  test('the initial-session path records listening before answering', () => {
    const start = SRC.indexOf('async function maybeCreateInitialOpencodeSession(')
    const end = SRC.indexOf('\nasync function resolveExistingRoot', start)
    const body = SRC.slice(start, end)
    const resolveAt = body.indexOf('await resolveExistingRoot(')
    const listeningAt = body.indexOf('onListening,', resolveAt)
    const answeringAt = body.indexOf("bootMark('opencode-answering')")

    expect(resolveAt).toBeGreaterThan(-1)
    expect(listeningAt).toBeGreaterThan(resolveAt)
    expect(answeringAt).toBeGreaterThan(listeningAt)
  })

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
    expect(body).toContain(
      'alreadyDelivered = reusedRootAlreadyDelivered(existing, priorPin, priorDeliveredMarker)',
    )
    // T22: `priorPin` must be captured BEFORE `resolveExistingRoot` runs, so it
    // reflects only what a PRIOR boot pinned — never this boot's own pending
    // write (see `pinOpencodeSessionFile` further down the same function).
    const priorPinReadAt = body.indexOf('const priorPin = readPinnedOpencodeSessionId()')
    const resolveCallAt = body.indexOf('await resolveExistingRoot(')
    const pinWriteAt = body.indexOf('pinOpencodeSessionFile(')
    expect(priorPinReadAt).toBeGreaterThan(-1)
    expect(priorPinReadAt).toBeLessThan(resolveCallAt)
    expect(priorPinReadAt).toBeLessThan(pinWriteAt)
    // F1: `priorDeliveredMarker` must likewise be captured before delivery —
    // it must reflect only a PRIOR boot's successful delivery, never this
    // boot's own (possible) marker write further down the same function.
    const priorMarkerReadAt = body.indexOf('const priorDeliveredMarker = readInitialPromptDeliveredMarker()')
    const markerWriteAt = body.indexOf('markInitialPromptDelivered()')
    expect(priorMarkerReadAt).toBeGreaterThan(-1)
    expect(priorMarkerReadAt).toBeLessThan(resolveCallAt)
    expect(priorMarkerReadAt).toBeLessThan(markerWriteAt)
  })

  test('F1: the delivery marker is written only after accepted prompt publication', () => {
    const start = SRC.indexOf('async function maybeCreateInitialOpencodeSession(')
    const end = SRC.indexOf('\nasync function resolveExistingRoot', start)
    const body = SRC.slice(start, end)
    const deliverCallAt = body.indexOf('await publishInitialOpenCodeSessionAfterPrompt(')
    const markerWriteAt = body.indexOf('markInitialPromptDelivered()')
    expect(deliverCallAt).toBeGreaterThan(-1)
    expect(markerWriteAt).toBeGreaterThan(deliverCallAt)
  })
})

describe('reusedRootAlreadyDelivered — F1: bare pin is no longer proof of delivery', () => {
  test('F1 RED: crash-window boot — pin exists, NO marker, transcript confirmed empty → delivers', () => {
    // The exact shape a crash between the pin write and delivery leaves
    // behind: `resolveExistingRoot` re-finds the pinned root (chosen.id ===
    // priorPin), the read succeeded (known: true) and found zero messages,
    // because nothing was ever delivered. The old T22 rule ("any prior pin
    // proves delivery") would return true here and silence the session
    // forever. F1 requires this to deliver.
    expect(
      reusedRootAlreadyDelivered(
        { id: 'ses_prior_pin', known: true, hasMessages: false },
        'ses_prior_pin',
        false,
      ),
    ).toBe(false)
  })

  test('F1: truncated-after-delivery — marker present → never redelivers (T22 intent, now via the marker)', () => {
    // Same transcript shape as the crash-window case (revert emptied it),
    // but this time the marker proves delivery genuinely happened once.
    expect(
      reusedRootAlreadyDelivered(
        { id: 'ses_prior_pin', known: true, hasMessages: false },
        'ses_prior_pin',
        true,
      ),
    ).toBe(true)
  })

  test('F1: marker alone is sufficient even with no prior pin at all', () => {
    expect(
      reusedRootAlreadyDelivered({ id: 'ses_new_root', known: true, hasMessages: false }, null, true),
    ).toBe(true)
  })

  test('F1 RED: different-root case — chosen root != priorPin, no marker → delivers', () => {
    // The pinned root is gone; `resolveExistingRoot` fell through to a
    // DIFFERENT, never-prompted root. The old gate skipped delivery here too
    // (any prior pin, regardless of which root was chosen). F1 requires the
    // chosen root to match the pin before trusting it.
    expect(
      reusedRootAlreadyDelivered(
        { id: 'ses_different_root', known: true, hasMessages: false },
        'ses_prior_pin',
        false,
      ),
    ).toBe(false)
  })

  test('a prior pin overrides an unreadable transcript too (unknown reads never redeliver — unchanged from T12)', () => {
    expect(
      reusedRootAlreadyDelivered(
        { id: 'ses_prior_pin', known: false, hasMessages: false },
        'ses_prior_pin',
        false,
      ),
    ).toBe(true)
  })

  test('pinless + has messages: still delivered (unchanged from T12)', () => {
    expect(
      reusedRootAlreadyDelivered({ id: 'ses_new_root', known: true, hasMessages: true }, null, false),
    ).toBe(true)
  })

  test('pinless + genuinely empty: not yet delivered, deliver now (unchanged from T12)', () => {
    expect(
      reusedRootAlreadyDelivered({ id: 'ses_new_root', known: true, hasMessages: false }, null, false),
    ).toBe(false)
  })
})

/**
 * The root list is asked for ROOTS, server-side.
 *
 * `GET /session` declares `roots`, `limit`, `start`, `search` and `scope` on
 * BOTH opencode 1.17.11 and 1.18.19 — probed against the real binaries on
 * 2026-08-20, where `?roots=true&limit=1` returned exactly the
 * most-recently-updated ROOT out of three roots plus one newer child. Boxes
 * provisioned before today still run 1.17.11, which is why this can be one
 * call with no version fork.
 *
 * The client-side `!parentID` filter is kept anyway: an opencode that does not
 * know a query parameter ignores it silently, and adopting a Task-tool CHILD as
 * the canonical root would orphan the conversation.
 */
describe('listOpencodeRoots — server-side root filter', () => {
  function recordingServer(sessions: Array<Record<string, unknown>>) {
    const queries: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method === 'GET' && /\/session$/.test(url.pathname)) {
          queries.push(url.search)
          return Response.json(sessions)
        }
        if (req.method === 'GET' && url.pathname.endsWith('/message')) return Response.json([])
        return new Response('not found', { status: 404 })
      },
    })
    servers.push(server)
    return { baseUrl: `http://127.0.0.1:${server.port}`, queries: () => queries }
  }

  test('asks opencode for roots=true instead of paging every session', async () => {
    const s = recordingServer([{ id: 'ses_root', time: { created: 1, updated: 1 } }])
    const result = await resolveExistingRoot(s.baseUrl, '/workspace', null)
    expect(result.status).toBe('found')
    expect(s.queries()[0]).toContain('roots=true')
    expect(s.queries()[0]).toContain('directory=%2Fworkspace')
  })

  test('a CHILD that leaks through is still never adopted as the root', async () => {
    // Defence in depth: an opencode that ignored `roots` would answer with
    // children too. The newest row here is a child; the root must still win.
    const s = recordingServer([
      { id: 'ses_child', parentID: 'ses_root', time: { created: 9, updated: 9 } },
      { id: 'ses_root', time: { created: 1, updated: 1 } },
    ])
    const result = await resolveExistingRoot(s.baseUrl, '/workspace', null)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.root.id).toBe('ses_root')
  })

  test('the PINNED root still wins over a more recently updated one', async () => {
    // Why `limit=1` is not used: the pin must remain findable in this list.
    const s = recordingServer([
      { id: 'ses_newer', time: { created: 5, updated: 9 } },
      { id: 'ses_pinned', time: { created: 1, updated: 2 } },
    ])
    const result = await resolveExistingRoot(s.baseUrl, '/workspace', 'ses_pinned')
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.root.id).toBe('ses_pinned')
  })
})
