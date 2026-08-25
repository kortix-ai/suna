/**
 * Attachment offload: inline image bytes out of OpenCode's SQLite transcript.
 *
 * The fixture mirrors opencode.db on Essentia box i67m4 (1.18.23, 2026-08-25):
 * `part` rows whose `data` JSON is a tool part with `state.attachments[]` of
 * file-shaped objects carrying base64 `data:` URLs.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFLOAD_PLACEHOLDER_URL,
  decodeDataUrl,
  inlineAttachmentsOf,
  runAttachmentOffloadPass,
  selectCandidates,
  sidecarPathFor,
} from '../attachment-offload'
import { stripInlineAttachmentBytes } from '../inline-attachments'

let root: string
let dbPath: string
let sidecarDir: string

const PNG_1PX_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function bigDataUrl(seed: string, bytes = 64 * 1024): string {
  return `data:image/png;base64,${Buffer.from(seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes)).toString('base64')}`
}

function schema(db: Database): void {
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `)
}

interface Seeded {
  partId: string
  attachmentIds: string[]
}

function seedToolPart(
  db: Database,
  session: string,
  message: string,
  n: number,
  t: number,
  opts: { attachments?: number; compacted?: boolean; small?: boolean } = {},
): Seeded {
  const partId = `prt_${session}_${n.toString().padStart(3, '0')}`
  const count = opts.attachments ?? 1
  const attachmentIds: string[] = []
  const attachments = Array.from({ length: count }, (_, i) => {
    const id = `${partId}_att${i}`
    attachmentIds.push(id)
    return {
      type: 'file',
      mime: 'image/png',
      url: opts.small ? `data:image/png;base64,${PNG_1PX_B64}` : bigDataUrl(`${partId}-${i}-`),
      id,
      sessionID: session,
      messageID: message,
    }
  })
  const data = {
    id: partId,
    sessionID: session,
    messageID: message,
    type: 'tool',
    callID: `call_${n}`,
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: `/workspace/shot-${n}.png` },
      output: 'Image read successfully',
      title: `shot-${n}.png`,
      metadata: {},
      time: { start: t, end: t + 5, ...(opts.compacted ? { compacted: t + 10 } : {}) },
      attachments,
    },
  }
  db.run('INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)', [
    message,
    session,
    t,
    t,
    JSON.stringify({ id: message, sessionID: session, role: 'assistant', time: { created: t, completed: t + 100 } }),
  ])
  db.run('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)', [
    partId,
    message,
    session,
    t,
    t,
    JSON.stringify(data),
  ])
  return { partId, attachmentIds }
}

function readPart(db: Database, id: string): Record<string, any> {
  const row = db.query<{ data: string }, [string]>('SELECT data FROM part WHERE id = ?').get(id)
  return JSON.parse(row!.data)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-offload-'))
  dbPath = join(root, 'opencode.db')
  sidecarDir = join(root, 'attachments')
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  schema(db)
  db.close()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('helpers', () => {
  test('inlineAttachmentsOf sees tool attachments and top-level file parts', () => {
    expect(inlineAttachmentsOf({ type: 'file', url: 'data:x', id: 'a' })).toHaveLength(1)
    expect(inlineAttachmentsOf({ type: 'tool', state: { attachments: [{ url: 'data:y', id: 'b' }, { nope: 1 }] } })).toHaveLength(1)
    expect(inlineAttachmentsOf({ type: 'text', text: 'hi' })).toHaveLength(0)
  })

  test('decodeDataUrl returns mime + bytes', () => {
    const d = decodeDataUrl(`data:image/png;base64,${PNG_1PX_B64}`)!
    expect(d.mime).toBe('image/png')
    expect(d.bytes.byteLength).toBe(Buffer.from(PNG_1PX_B64, 'base64').byteLength)
  })

  test('sidecarPathFor never leaves the directory', () => {
    expect(sidecarPathFor('/x', '../../etc/passwd')).toBe('/x/______etc_passwd')
  })

  test('selectCandidates keeps the newest N attachments per session and never the newest message', () => {
    const rows = [
      { id: 'p1', session_id: 's', message_id: 'm1', time_created: 1, attachmentCount: 5 },
      { id: 'p2', session_id: 's', message_id: 'm2', time_created: 2, attachmentCount: 5 },
      { id: 'p3', session_id: 's', message_id: 'm3', time_created: 3, attachmentCount: 5 },
      { id: 'p4', session_id: 's', message_id: 'm4', time_created: 4, attachmentCount: 5 },
      { id: 'pc', session_id: 's', message_id: 'm2', time_created: 2, attachmentCount: 1, compacted: true },
    ]
    const chosen = selectCandidates(rows, new Map([['s', 'm4']]), 12)
    // newest message m4 untouched; the window keeps whole parts until AT LEAST
    // 12 attachments are kept: p3 (5) + p2 (10) + p1 (15) all stay; compacted always goes
    expect(chosen).toEqual(new Set(['pc']))
    // With a 6-wide window p1 goes: p3 (5) + p2 (10 ≥ 6) kept, p1 offloaded.
    expect(selectCandidates(rows, new Map([['s', 'm4']]), 6)).toEqual(new Set(['p1', 'pc']))
  })
})

describe('runAttachmentOffloadPass', () => {
  test('moves old attachments to sidecars, leaves a valid placeholder + marker, keeps the newest window inline', async () => {
    const db = new Database(dbPath)
    const S = 'ses_root'
    const seeded: Seeded[] = []
    // 20 tool parts, one attachment each, older → newer; the newest message is a live one.
    for (let i = 0; i < 20; i++) seeded.push(seedToolPart(db, S, `msg_${i}`, i, 1_000 + i))
    db.close()

    const result = await runAttachmentOffloadPass({ dbPath, sidecarDir, keepNewest: 12 })
    expect(result.errors).toBe(0)
    // 20 parts, newest message (msg_19) excluded, newest 12 kept → parts 7..18 kept, 0..6 offloaded
    expect(result.offloaded).toBe(7)
    expect(result.bytesMoved).toBeGreaterThan(7 * 60 * 1024)

    const check = new Database(dbPath, { readonly: true })
    for (let i = 0; i < 20; i++) {
      const part = readPart(check, seeded[i]!.partId)
      const att = part.state.attachments[0]
      if (i <= 6) {
        expect(att.url).toBe(OFFLOAD_PLACEHOLDER_URL)
        expect(att.kortix.offloaded).toBe(true)
        expect(att.kortix.mime).toBe('image/png')
        expect(att.kortix.bytes).toBeGreaterThan(60 * 1024)
        expect(existsSync(att.kortix.sidecar)).toBe(true)
        expect(readFileSync(att.kortix.sidecar).byteLength).toBe(att.kortix.bytes)
        // Attachment identity untouched: the UI's on-demand ref still resolves.
        expect(att.id).toBe(seeded[i]!.attachmentIds[0])
        expect(att.type).toBe('file')
      } else {
        expect(att.url.startsWith('data:image/png;base64,')).toBe(true)
        expect(att.url.length).toBeGreaterThan(60 * 1024)
        expect(att.kortix).toBeUndefined()
      }
    }
    check.close()

    // Idempotent: a second pass finds nothing left to do.
    const again = await runAttachmentOffloadPass({ dbPath, sidecarDir, keepNewest: 12 })
    expect(again.offloaded).toBe(0)
    expect(again.errors).toBe(0)
  })

  test('a compacted tool result is offloaded even inside the newest window; tiny attachments stay inline', async () => {
    const db = new Database(dbPath)
    const S = 'ses_root'
    const a = seedToolPart(db, S, 'msg_a', 1, 1_000, { compacted: true })
    const b = seedToolPart(db, S, 'msg_b', 2, 1_001)
    const c = seedToolPart(db, S, 'msg_c', 3, 1_002, { small: true })
    seedToolPart(db, S, 'msg_live', 4, 1_003)
    db.close()
    const result = await runAttachmentOffloadPass({ dbPath, sidecarDir, keepNewest: 12 })
    expect(result.offloaded).toBe(1)
    const check = new Database(dbPath, { readonly: true })
    expect(readPart(check, a.partId).state.attachments[0].kortix?.offloaded).toBe(true)
    expect(readPart(check, b.partId).state.attachments[0].kortix).toBeUndefined()
    expect(readPart(check, c.partId).state.attachments[0].kortix).toBeUndefined()
    check.close()
  })

  test('a row OpenCode touched between read and write is skipped, not clobbered', async () => {
    const db = new Database(dbPath)
    const S = 'ses_root'
    const old = seedToolPart(db, S, 'msg_old', 1, 1_000)
    for (let i = 0; i < 13; i++) seedToolPart(db, S, `msg_${i + 2}`, i + 2, 2_000 + i)
    // Simulate a concurrent writer: bump time_updated so the optimistic UPDATE misses.
    db.run('UPDATE part SET time_updated = time_updated + 1 WHERE id = ?', [old.partId])
    db.close()
    // The pass reads the row (with the new time_updated) and updates against it —
    // so this only proves the WHERE clause by racing it: patch after select.
    // Do that with a second connection while the pass runs.
    const racer = new Database(dbPath)
    try {
      const result = await runAttachmentOffloadPass({
        dbPath,
        sidecarDir,
        keepNewest: 12,
        // A concurrent writer (OpenCode) touches the row between our read and our write.
        beforeUpdate: (id) => racer.run('UPDATE part SET time_updated = time_updated + 1 WHERE id = ?', [id]),
      })
      expect(result.offloaded).toBe(0)
      expect(result.skippedBusy).toBe(1)
    } finally {
      racer.close()
    }
    const check = new Database(dbPath, { readonly: true })
    expect(readPart(check, old.partId).state.attachments[0].kortix).toBeUndefined()
    check.close()
  })

  test('a missing database is a counted error, never a throw', async () => {
    const result = await runAttachmentOffloadPass({ dbPath: join(root, 'nope', 'x.db'), sidecarDir })
    expect(result.errors).toBe(1)
    expect(result.offloaded).toBe(0)
  })

  test('the response stripper hands an offloaded attachment out as a ref regardless of its size', () => {
    const offloaded = {
      type: 'file',
      id: 'prt_att',
      messageID: 'msg_1',
      mime: 'image/png',
      url: OFFLOAD_PLACEHOLDER_URL,
      kortix: { offloaded: true, sidecar: '/x/prt_att', bytes: 123, mime: 'image/png', at: 't' },
    }
    const result = stripInlineAttachmentBytes(
      [{ info: { id: 'msg_1' }, parts: [{ type: 'tool', state: { attachments: [offloaded] } }] }],
      (m, p) => `/kortix/part/s/${m}/${p}`,
    )
    expect(result.stripped).toBe(1)
    const out = result.value as any
    expect(out[0].parts[0].state.attachments[0].url).toBe('/kortix/part/s/msg_1/prt_att')
  })
})
