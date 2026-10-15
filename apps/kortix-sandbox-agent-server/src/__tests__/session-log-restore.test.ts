/**
 * The restore-response helper (P6.2): a `SessionLogRestore` (P6.1) becomes the
 * `SessionLog` a harness adapter restores. Each text the API stored by
 * reference is read in full through the attachments route of a fake API; a
 * text the answer does not list, a read that fails and a body whose digest is
 * wrong keep their preview and are reported as truncated.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { SessionLogRestoreSchema, type SessionLog, type SessionLogMessage, type SessionLogRestore } from '@kortix/api-contract/session-log'
import { apiBytesReader, apiTextReader, attachmentBytes, sessionLogFromRestore } from '@/harness/shared/session-log-restore'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const id = (n: number) => `33333333-3333-4333-8333-33333333333${n}`
const ref = (n: number) => `kortix-attachment://${PROJECT}/${SESSION}/${id(n)}`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const FULL = ['A'.repeat(300_000), 'B'.repeat(300_000), 'C'.repeat(300_000), 'D'.repeat(300_000)]
const preview = (text: string) => text.slice(0, 16_384)
const at = '2026-10-13T00:00:00.000Z'

function message(id: string, blocks: SessionLogMessage['blocks']): SessionLogMessage {
  return {
    schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'ses_root', seq: 1, role: 'assistant', kind: 'turn', status: 'complete', in_context: true,
    model: null, usage: null, finish: 'stop', error: null, created_at: at, completed_at: at, producer: { harness: 'pi', harness_version: '1.0.3', adapter_version: '1.0.0' }, blocks,
  }
}

function restoreAnswer(): SessionLogRestore {
  const big = (n: number) => ({ text: preview(FULL[n]!), ref: ref(n), bytes: FULL[n]!.length })
  const messages = [
    message('msg_text', [{ type: 'text', id: 'b1', ...big(0) }]),
    message('msg_tool', [{
      type: 'tool_call', id: 'b2', call_id: 'call_1', name: 'bash', kind: 'shell', input: { command: 'cat big' }, status: 'complete',
      result: { content: [{ type: 'text', ...big(1) }], is_error: false },
    }]),
    // Stored by reference, but the answer has no blobs entry for it: truncated.
    message('msg_unlisted', [{ type: 'text', id: 'b3', ...big(2) }]),
    // Listed, but the API serves a body whose digest differs: truncated.
    message('msg_corrupt', [{ type: 'text', id: 'b4', ...big(3) }]),
    message('msg_small', [{ type: 'text', id: 'b5', text: 'small' }]),
  ]
  for (const [i, m] of messages.entries()) m.seq = i + 1
  const answer = {
    generation: 3,
    log: {
      schema: 'kortix.session/2', v: 1, session_id: SESSION, title: null, created_at: at, restore_grade: 'native',
      harness: { current: 'pi', history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] },
      threads: [{ schema: 'kortix.session/2', v: 1, thread_id: 'ses_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: at, messages }],
    },
    revs: { msg_text: 11, msg_tool: 12, msg_unlisted: 13, msg_corrupt: 14, msg_small: 15, msg_gone: 16 },
    blobs: [
      { message_id: 'msg_text', block_id: 'b1', ref: ref(0), bytes: FULL[0]!.length, sha256: sha(FULL[0]!) },
      { message_id: 'msg_tool', block_id: 'b2', ref: ref(1), bytes: FULL[1]!.length, sha256: sha(FULL[1]!) },
      { message_id: 'msg_corrupt', block_id: 'b4', ref: ref(3), bytes: FULL[3]!.length, sha256: sha(FULL[3]!) },
    ],
  }
  return SessionLogRestoreSchema.parse(answer)
}

const servers: Array<{ stop(force?: boolean): void }> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

/** The attachments route of a fake API: serves FULL[n] for id(n), a wrong body for id(3), and records each request. */
function fakeApi() {
  const requests: Array<{ path: string; auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, auth: request.headers.get('authorization') })
      const n = [0, 1, 2, 3].find((i) => url.pathname === `/v1/projects/${PROJECT}/sessions/${SESSION}/attachments/${id(i)}`)
      if (n === undefined) return new Response('not found', { status: 404 })
      return new Response(n === 3 ? 'tampered' : FULL[n], { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    },
  })
  servers.push(server)
  return { requests, ctx: { projectId: PROJECT, sessionId: SESSION, token: 'sandbox-token', apiRoot: `http://127.0.0.1:${server.port}/v1` } }
}

describe('sessionLogFromRestore (P6.2)', () => {
  test('each listed text is read in full through the attachments route; the rest keep their preview and are reported', async () => {
    const api = fakeApi()
    const answer = restoreAnswer()
    const out = await sessionLogFromRestore(answer, apiTextReader(api.ctx))
    const [text, tool, unlisted, corrupt, small] = out.log.threads[0]!.messages

    expect(text!.blocks[0]).toEqual({ type: 'text', id: 'b1', text: FULL[0]! })
    expect((tool!.blocks[0] as { result: { content: unknown[] } }).result.content).toEqual([{ type: 'text', text: FULL[1]! }])
    // Truncated: the preview stays, with its ref and bytes, so the record still says it is partial.
    expect(unlisted!.blocks[0]).toEqual({ type: 'text', id: 'b3', text: preview(FULL[2]!), ref: ref(2), bytes: FULL[2]!.length })
    expect(corrupt!.blocks[0]).toMatchObject({ text: preview(FULL[3]!), ref: ref(3) })
    expect(small!.blocks[0]).toEqual({ type: 'text', id: 'b5', text: 'small' })
    expect(out.truncated).toEqual([
      { message_id: 'msg_unlisted', block_id: 'b3', ref: ref(2), reason: 'not_listed' },
      { message_id: 'msg_corrupt', block_id: 'b4', ref: ref(3), reason: 'sha256_mismatch' },
    ])
    expect(out).toMatchObject({ generation: 3, revs: answer.revs })
    // The input is not changed: the caller may log or retry it.
    expect(answer.log.threads[0]!.messages[0]!.blocks[0]).toMatchObject({ ref: ref(0) })

    // One GET per listed text, with the sandbox credential; the unlisted one is never read.
    expect(api.requests.map((r) => r.path).sort()).toEqual([0, 1, 3].map((n) => `/v1/projects/${PROJECT}/sessions/${SESSION}/attachments/${id(n)}`).sort())
    for (const r of api.requests) expect(r.auth).toBe('Bearer sandbox-token')
  })

  test('a read that fails keeps the preview; a ref outside this session is never read', async () => {
    const api = fakeApi()
    const answer = restoreAnswer()
    answer.blobs[0]!.ref = `kortix-attachment://${PROJECT}/44444444-4444-4444-8444-444444444444/${id(0)}`
    ;(answer.log.threads[0]!.messages[0]!.blocks[0] as { ref: string }).ref = answer.blobs[0]!.ref
    const reader = apiTextReader({ ...api.ctx, apiRoot: 'http://127.0.0.1:9/v1' }) // nothing listens
    const out = await sessionLogFromRestore(answer, async (r, signal) => (r === answer.blobs[1]!.ref ? reader(r, signal) : apiTextReader(api.ctx)(r, signal)))
    expect(out.truncated.map((t) => [t.message_id, t.reason])).toEqual([
      ['msg_text', 'unreadable'],
      ['msg_tool', 'unreadable'],
      ['msg_unlisted', 'not_listed'],
      ['msg_corrupt', 'sha256_mismatch'],
    ])
    expect(api.requests.map((r) => r.path)).toEqual([`/v1/projects/${PROJECT}/sessions/${SESSION}/attachments/${id(3)}`])
  })
})

describe('deadlines (P6.2 review)', () => {
  /** An attachments route that never answers until the client gives up. */
  function hungApi() {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        requests += 1
        return new Promise<Response>((resolve) => request.signal.addEventListener('abort', () => resolve(new Response('gone', { status: 499 })), { once: true }))
      },
    })
    servers.push(server)
    return { requests: () => requests, ctx: { projectId: PROJECT, sessionId: SESSION, token: 'sandbox-token', apiRoot: `http://127.0.0.1:${server.port}/v1` } }
  }

  test('a hung read times out per attempt and is tried 3 times, then it is unreadable', async () => {
    const api = hungApi()
    const started = Date.now()
    expect(await apiTextReader(api.ctx, { attemptMs: 50, retryMs: 1 })(ref(0))).toBeNull()
    expect(api.requests()).toBe(3)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('the budget for all reads: past it, every text left keeps its preview as unreadable', async () => {
    const api = hungApi()
    const started = Date.now()
    const out = await sessionLogFromRestore(restoreAnswer(), apiTextReader(api.ctx, { attemptMs: 10_000, retryMs: 1 }), { budgetMs: 150 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(out.truncated.map((t) => [t.message_id, t.reason])).toEqual([
      ['msg_text', 'unreadable'],
      ['msg_tool', 'unreadable'],
      ['msg_unlisted', 'not_listed'],
      ['msg_corrupt', 'unreadable'],
    ])
  })

  test('attachment reads have their own budget: past it, every attachment left has no bytes', async () => {
    const api = hungApi()
    const log = restoreAnswer().log as SessionLog
    log.threads[0]!.messages[0]!.blocks.push(
      { type: 'attachment', id: 'a1', mime: 'image/png', ref: ref(0), bytes: 1 },
      { type: 'attachment', id: 'a2', mime: 'image/png', ref: ref(1), bytes: 1 },
      { type: 'attachment', id: 'a3', mime: 'image/png', ref: ref(2), bytes: 1 },
    )
    const started = Date.now()
    const out = await attachmentBytes(log, apiBytesReader(api.ctx, { attemptMs: 10_000, retryMs: 1 }), { budgetMs: 150 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect([...out.values()]).toEqual([null, null, null])
  })
})

describe('attachment bytes (P6.3)', () => {
  test('apiBytesReader returns the stored bytes unchanged; attachmentBytes keeps only bytes that match the digest', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a])
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => new URL(request.url).pathname.endsWith(id(0)) ? new Response(bytes, { headers: { 'content-type': 'image/png' } }) : new Response('not found', { status: 404 }),
    })
    servers.push(server)
    const read = apiBytesReader({ projectId: PROJECT, sessionId: SESSION, token: 'sandbox-token', apiRoot: `http://127.0.0.1:${server.port}/v1` })
    expect(await read(ref(0))).toEqual(bytes)
    expect(await read(ref(1))).toBeNull()
    const digest = createHash('sha256').update(bytes).digest('hex')
    const log = restoreAnswer().log as SessionLog
    log.threads[0]!.messages[0]!.blocks.push(
      { type: 'attachment', id: 'a1', mime: 'image/png', ref: ref(0), bytes: bytes.length, sha256: digest },
      { type: 'attachment', id: 'a2', mime: 'image/png', ref: `blob:${'0'.repeat(64)}`, bytes: 1 },
    )
    const out = await attachmentBytes(log, read)
    expect(out.get(ref(0))).toEqual(bytes)
    // A ref the reader cannot serve (a native `blob:` with no upload) has no bytes.
    expect(out.get(`blob:${'0'.repeat(64)}`)).toBeNull()
    // Wrong bytes for the digest: none.
    expect((await attachmentBytes(log, async () => Buffer.from('tampered'))).get(ref(0))).toBeNull()
  })

  test('P2.13: attachments are read 4 at a time', async () => {
    const log = restoreAnswer().log as SessionLog
    for (let i = 0; i < 10; i++) log.threads[0]!.messages[0]!.blocks.push({ type: 'attachment', id: `a${i}`, mime: 'image/png', ref: ref(i), bytes: 1 })
    let inFlight = 0
    let most = 0
    const out = await attachmentBytes(log, async () => {
      most = Math.max(most, ++inFlight)
      await Bun.sleep(20)
      inFlight--
      return Buffer.from('x')
    })
    expect(most).toBe(4)
    expect([...out.values()].every((b) => b?.toString() === 'x')).toBe(true)
    expect(out.size).toBe(10)
  })
})
