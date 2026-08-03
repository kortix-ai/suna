/**
 * A turn whose opencode process died must be ENDED, not left running forever.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error` over SSE.
 * A killed or crashed opencode emits neither, so the last assistant message
 * stays incomplete and every client streaming it spins — which is what an agent
 * running `kill <opencode pid>` from its own shell produces, and equally what an
 * OOM produces. The supervisor respawns the box within ~500ms, so the sandbox is
 * fine; only the turn is stranded.
 *
 * Boot already finalized such a turn when it adopted a root. These tests cover
 * the extracted version, which the supervisor's unplanned-respawn hook now calls
 * too.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { finalizeOrphanedTurn } from '../main'

const BASE = 'http://127.0.0.1:4096'
const WORKSPACE = '/workspace'
const SESSION = 'ses_abc'

const ORIGINAL_FETCH = globalThis.fetch
let calls: string[] = []

function stubFetch(messages: unknown, opts: { messagesOk?: boolean; abortThrows?: boolean } = {}) {
  calls = []
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
    if (url.includes('/abort')) {
      if (opts.abortThrows) throw new Error('connection refused')
      return new Response('{}', { status: 200 })
    }
    if (opts.messagesOk === false) return new Response('nope', { status: 503 })
    return new Response(JSON.stringify(messages), { status: 200 })
  }
}

afterEach(() => {
  ;(globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH
})

const assistantTurn = (completed?: number) => [
  { info: { role: 'user', time: { completed: 1 } } },
  { info: { role: 'assistant', time: completed === undefined ? {} : { completed } } },
]

describe('finalizeOrphanedTurn', () => {
  test('aborts an assistant turn that never completed', async () => {
    stubFetch(assistantTurn(undefined));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true)
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/abort'))).toBe(true)
  })

  test('leaves a COMPLETED turn alone', async () => {
    // Aborting a finished turn would be a visible lie in the transcript, and the
    // supervisor's hook fires on every unplanned respawn — including ones where
    // nothing was in flight.
    stubFetch(assistantTurn(1_700_000_000));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false)
    expect(calls.some((c) => c.includes('/abort'))).toBe(false)
  })

  test('a session whose last message is the USER is not an orphaned turn', async () => {
    // The prompt never reached the model. There is no assistant message to end.
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }])

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false)
  })

  test('an empty session is not an orphaned turn', async () => {
    stubFetch([])
    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false)
  })

  test('an unreadable message list does NOT abort', async () => {
    // opencode may still be coming back up after the respawn. Aborting on a
    // failed read would end turns that are perfectly alive.
    stubFetch(null, { messagesOk: false })

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false)
    expect(calls.some((c) => c.includes('/abort'))).toBe(false)
  })

  test('a failing abort is swallowed, never thrown at the supervisor', async () => {
    // This runs from the respawn path. A daemon that cannot finish bringing
    // opencode back because it could not tidy up a turn is worse than a spinner.
    stubFetch(assistantTurn(undefined), { abortThrows: true })

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true)
  })

  test('the session id and workspace are passed through url-encoded', async () => {
    stubFetch(assistantTurn(undefined))
    await finalizeOrphanedTurn(BASE, '/work space', 'ses/1')

    expect(calls.every((c) => !c.includes('ses/1'))).toBe(true)
  })
})
