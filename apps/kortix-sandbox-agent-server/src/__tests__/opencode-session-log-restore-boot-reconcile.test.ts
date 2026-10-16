// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SessionLog } from '@kortix/api-contract/session-log'
import { writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { reconcileSessionLog } from '@/harness/shared/session-log-boot'
import { flushSessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { Database } from 'bun:sqlite'
import { fakeSessionLogApi } from './helpers/fake-session-log-api'
import { useRestoreHarness, FIXTURE_PNG, sha, blobs, model, saved, box, post, prompt, oracle, load } from './helpers/opencode-restore'

useRestoreHarness()

describe('the boot reconcile on OpenCode (P6.4)', () => {
  const PROJECT = 'proj-oc-restore'
  /** golden, its image stored by the API (a `kortix-attachment://` object the box reads). */
  const storedImage = () => {
    const log = load('golden')
    const image = log.threads[0]!.messages.find((m) => m.message_id === 'msg_g04')!.blocks.find((b) => b.type === 'attachment') as { ref: string }
    image.ref = `kortix-attachment://${PROJECT}/${log.session_id}/img-1`
    return log
  }
  const objects = new Map([['img-1', FIXTURE_PNG]])
  const restores = (api: ReturnType<typeof fakeSessionLogApi>) => api.calls.filter((c) => c === 'POST log/restore').length
  const ids = (log: SessionLog) => log.threads.flatMap((t) => t.messages.map((m) => m.message_id))
  afterEach(() => resetSessionLogJournalForTests())

  test('held: null without a store, without the pinned root or without the seq map; a reverted message stays held', async () => {
    const log = load('golden')
    const b = box(log.session_id)
    expect(await b.port.held()).toBeNull()
    await b.port.restore(log)
    const held = await b.port.held()
    expect([...held!].sort()).toEqual(ids(log).sort())
    // OpenCode deletes a reverted message; until the journal tombstones it, the store did hold it.
    const db = new Database(b.dbPath)
    db.run('PRAGMA foreign_keys = ON')
    db.run("DELETE FROM message WHERE id = 'msg_g14'")
    db.close()
    expect((await b.port.held())!.has('msg_g14')).toBe(true)
    writeOpenCodeSessionPin('ses_not_in_the_store')
    expect(await b.port.held()).toBeNull()
    writeOpenCodeSessionPin(log.threads[0]!.thread_id)
    expect(await b.port.held()).not.toBeNull()
    rmSync(b.statePath)
    expect(await b.port.held()).toBeNull()
  }, 60_000)

  test('no native state: the box restores, the next request equals modelView; after a restart the store is current; a turn not yet journaled is kept', async () => {
    const log = storedImage()
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state'), objects })
    try {
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(api.calls).toEqual(['GET log/manifest', 'POST log/restore', 'GET attachments/img-1'])
      expect(boot.generation).toBe(1)
      expect(boot.session).toBeUndefined()
      startSessionLogJournal(b.port, boot)
      expect(await flushSessionLogJournal()).toBe(true)
      // The journal at the claimed generation sends nothing back: every restored record is skipped by hash.
      expect(api.journal.flatMap((x) => x.puts)).toEqual([])
      // P7.1: the log's harness (`fixture`) stays in the history; OpenCode serves the session from the first root seq after the restore.
      expect(api.journal.find((x) => x.session?.harness)?.session?.harness).toEqual({
        current: 'opencode',
        history: [...log.harness.history, { harness: 'opencode', version: expect.any(String), from_seq: Math.max(...log.threads[0]!.messages.map((m) => m.seq)) + 1, at: boot.harness!.at }],
      })
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'UNSENT-ANSWER' }])
      expect(oracle(log, rootId, 'Anything else?', body!).diffs).toEqual([])
      expect(JSON.stringify(body)).toContain(FIXTURE_PNG.toString('base64'))
      // The turn is in the store, not in the API (no flush ran): the store is ahead, never behind.
      resetSessionLogJournalForTests()
      expect(await reconcileSessionLog(b.port, { retryMs: 1 })).toEqual({ generation: 1, cursors: [], harness: boot.harness })
      expect(restores(api)).toBe(1)
      expect((await b.port.held())!.size).toBeGreaterThan(ids(log).length)
    } finally {
      api.stop()
    }
  }, 60_000)

  test('over the restore cap (413): the box boots with the note alone at the claimed generation and does not restore again', async () => {
    const log = storedImage()
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state'), objects, maxBytes: 1024 })
    try {
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(api.calls).toEqual(['GET log/manifest', 'POST log/restore'])
      expect(boot.generation).toBe(1)
      expect(boot.session).toMatchObject({ restore_grade: 'partial', ext: { kortix: { data: { restore: { generation: 1, dropped: { message: ids(log).length } } } } } })
      startSessionLogJournal(b.port, boot)
      expect(await flushSessionLogJournal()).toBe(true)
      expect(api.journal.flatMap((x) => x.puts.map((p) => [p.message.blocks[0]?.id, p.message.seq]))).toEqual([['prt_kortix_restore_g1', 15]])
      expect(new Set(api.journal.map((x) => x.generation))).toEqual(new Set([1]))
      const note = api.stored().threads[0]!.messages.at(-1)!
      const expected = { ...structuredClone(api.stored()), threads: [{ ...api.stored().threads[0]!, messages: [note] }] }
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'OK' }])
      expect(JSON.stringify(body)).toContain('is above the 1 KiB restore limit and was not restored.')
      expect(oracle(expected, rootId, 'Anything else?', body!).diffs).toEqual([])
      resetSessionLogJournalForTests()
      expect(await reconcileSessionLog(b.port, { retryMs: 1 })).toMatchObject({ generation: 1, cursors: [] })
      expect(restores(api)).toBe(1)
    } finally {
      api.stop()
    }
  }, 60_000)

  test('stale native state (a store from before the last turns) is restored', async () => {
    const log = storedImage()
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const older = structuredClone(log)
    older.threads[0]!.messages = older.threads[0]!.messages.slice(0, -2)
    await b.port.restore(older)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state'), objects })
    try {
      expect((await reconcileSessionLog(b.port, { retryMs: 1 }))?.generation).toBe(1)
      expect(restores(api)).toBe(1)
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'OK' }])
      expect(oracle(log, rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 60_000)

  test('a partial restore (D3): the agent gets a note in its next request and the log, the user a partial session patch', async () => {
    // golden as stored: its image is a `blob:` the box cannot read through the API.
    const log = load('golden')
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state') })
    try {
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(boot.session).toMatchObject({ restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
      startSessionLogJournal(b.port, boot)
      expect(await flushSessionLogJournal()).toBe(true)
      expect(api.journal.flatMap((x) => x.puts.map((p) => p.message.blocks[0]?.id))).toEqual(['prt_kortix_restore_g1'])
      expect(api.journal[0]!.session).toMatchObject({ restore_grade: 'partial' })
      expect(api.stored().threads[0]!.messages.at(-1)).toMatchObject({ role: 'user', origin: 'notification', in_context: true, seq: 15, blocks: [{ id: 'prt_kortix_restore_g1' }] })
      const expected = structuredClone(api.stored())
      const g04 = expected.threads[0]!.messages.find((m) => m.message_id === 'msg_g04')!
      g04.blocks = g04.blocks.filter((x) => x.type !== 'attachment')
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'OK' }])
      expect(JSON.stringify(body)).toContain('Kortix: this session was restored from its saved session log. Some earlier content could not be restored: 1 attachment.')
      expect(oracle(expected, rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 60_000)

  test('P2.13: the journal stores a prompt image, a prompt PDF and a tool-result image; a fresh box restores them with nothing dropped', async () => {
    const sessionId = 'sess-oc-blobs'
    const empty: SessionLog = {
      schema: 'kortix.session/2', v: 1, session_id: sessionId, title: null, created_at: '2026-10-15T00:00:00.000Z', restore_grade: 'native',
      harness: { current: 'opencode', history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, threads: [],
    }
    // Synthetic files: a 1x1 PNG with the prompt, a minimal PDF, and a 2x2 PNG a tool reads from disk (not the 1x1 offload placeholder).
    const shot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC', 'base64')
    const pdf = Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n')
    const a = box(sessionId)
    writeFileSync(join(a.workspace, 'shot.png'), shot)
    const api = fakeSessionLogApi(empty, { projectId: PROJECT, stateDir: join(a.root, 'state') })
    try {
      const live = await a.serve()
      const { id: rootId } = (await post(live, '/session', {})) as { id: string }
      writeOpenCodeSessionPin(rootId)
      startSessionLogJournal(a.port, { generation: 0 })
      await prompt(live, rootId, 'what are these', [{ text: 'an image and a pdf' }], [
        { mime: 'image/png', url: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`, filename: 'prompt.png' },
        { mime: 'application/pdf', url: `data:application/pdf;base64,${pdf.toString('base64')}`, filename: 'notes.pdf' },
      ])
      await prompt(live, rootId, 'read the screenshot', [{ tool: 'read', args: { filePath: join(a.workspace, 'shot.png') } }, { text: 'a pixel' }])
      expect(await flushSessionLogJournal()).toBe(true)
      await live.stop()
      resetSessionLogJournalForTests()

      const own = `kortix-attachment://${PROJECT}/${sessionId}/`
      const messages = api.stored().threads.flatMap((t) => t.messages)
      const files = messages.flatMap((m) => m.blocks.filter((x) => x.type === 'attachment'))
      expect(files.map((x) => [x.mime, x.ref, x.sha256, x.bytes])).toEqual([
        ['image/png', `${own}blob-${sha(FIXTURE_PNG)}`, sha(FIXTURE_PNG), FIXTURE_PNG.length],
        ['application/pdf', `${own}blob-${sha(pdf)}`, sha(pdf), pdf.length],
      ])
      const toolFiles = messages.flatMap((m) => m.blocks.flatMap((x) => (x.type === 'tool_call' ? (x.result?.content ?? []).filter((c) => c.type === 'attachment') : [])))
      expect(toolFiles).toEqual([{ type: 'attachment', ref: `${own}blob-${sha(shot)}`, mime: 'image/png', sha256: sha(shot) }])
      expect([...api.objects.keys()].sort()).toEqual([sha(FIXTURE_PNG), sha(pdf), sha(shot)].map((x) => `blob-${x}`).sort())

      // A fresh box restores the stored log: every object read back, nothing dropped, the next request carries them.
      const b = box(sessionId)
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(boot.generation).toBe(1)
      expect(boot.session).toBeUndefined()
      expect(api.calls.filter((c) => c.startsWith('GET attachments/')).length).toBe(3)
      const server = await b.serve()
      const [body] = await prompt(server, b.native(rootId), 'Anything else?', [{ text: 'OK' }])
      const sent = JSON.stringify(body)
      for (const bytes of [FIXTURE_PNG, pdf, shot]) expect(sent).toContain(bytes.toString('base64'))
      expect(oracle(api.stored(), rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 90_000)
})
