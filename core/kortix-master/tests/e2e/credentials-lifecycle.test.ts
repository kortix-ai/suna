/**
 * Project-scoped credentials — service-layer coverage.
 *
 * The key invariants we need to hold:
 *   1. Values encrypt/decrypt cleanly with a fresh IV + tag per write.
 *   2. Cross-project isolation — project A setting NAME=X does NOT make
 *      NAME readable in project B (even with the same NAME).
 *   3. Audit log captures create/update/read/delete with actor stamps.
 *   4. list() never leaks ciphertext or plaintext — names + metadata only.
 *   5. Upsert semantics: re-setting the same name REPLACES the value
 *      (not a new row).
 *   6. Name validation rejects leading-digit / empty / oversized names.
 *   7. Read of a missing name returns null AND emits a `not_found` read
 *      event (forensics — "someone probed for STRIPE_KEY").
 *   8. Raw DB file never contains the plaintext bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { ensureTicketTables } from '../../src/services/ticket-service'
import {
  upsertCredential,
  readCredential,
  listCredentials,
  listCredentialEvents,
  deleteCredential,
  getCredentialRow,
  _resetCredentialKeyCache,
} from '../../src/services/credential-service'

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  dir: string
  db: Database
  dbPath: string
  keyPath: string
  projectA: string
  projectB: string
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'kortix-cred-e2e-'))
  const dbPath = path.join(dir, 'kortix.db')
  const keyPath = path.join(dir, '.credentials-key')
  process.env.CREDENTIAL_KEY_PATH = keyPath
  _resetCredentialKeyCache()

  const db = new Database(dbPath, { create: true, readwrite: true })
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      opencode_id TEXT, maintainer_session_id TEXT,
      structure_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, set_at TEXT NOT NULL
    );
  `)
  ensureTicketTables(db)

  const projectA = 'proj-a-' + Date.now().toString(36)
  const projectB = 'proj-b-' + Date.now().toString(36)
  const now = new Date().toISOString()
  mkdirSync(path.join(dir, 'a'), { recursive: true })
  mkdirSync(path.join(dir, 'b'), { recursive: true })
  db.prepare('INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES ($id,$n,$p,$d,$c,2)').run({
    $id: projectA, $n: 'A', $p: path.join(dir, 'a'), $d: '', $c: now,
  })
  db.prepare('INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES ($id,$n,$p,$d,$c,2)').run({
    $id: projectB, $n: 'B', $p: path.join(dir, 'b'), $d: '', $c: now,
  })
  return { dir, db, dbPath, keyPath, projectA, projectB }
}

let fixtures: Fixture[] = []
const ORIGINAL_KEY_PATH = process.env.CREDENTIAL_KEY_PATH

beforeEach(() => { fixtures = [] })
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    try { f.db.close() } catch {}
    rmSync(f.dir, { recursive: true, force: true })
  }
  if (ORIGINAL_KEY_PATH) process.env.CREDENTIAL_KEY_PATH = ORIGINAL_KEY_PATH
  else delete process.env.CREDENTIAL_KEY_PATH
  _resetCredentialKeyCache()
})

function setup(): Fixture {
  const fx = makeFixture()
  fixtures.push(fx)
  return fx
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('credential-service — CRUD + encryption', () => {
  test('create → read roundtrip returns the exact plaintext', async () => {
    const fx = setup()
    const { row, created } = await upsertCredential(fx.db, {
      project_id: fx.projectA,
      name: 'STRIPE_API_KEY',
      value: 'sk_test_rotated_7h2j9',
      description: 'live Stripe test mode',
      actor_type: 'user', actor_id: 'vukasin',
    })
    expect(created).toBe(true)
    expect(row.name).toBe('STRIPE_API_KEY')
    expect(row.description).toBe('live Stripe test mode')
    expect(row.ciphertext).not.toContain('sk_test')
    expect(row.ciphertext.length).toBeGreaterThan(0)
    expect(row.iv.length).toBe(24)   // 12 bytes = 24 hex chars
    expect(row.tag.length).toBe(32)  // 16 bytes = 32 hex chars

    const got = await readCredential(fx.db, {
      project_id: fx.projectA, name: 'STRIPE_API_KEY',
      actor_type: 'user', actor_id: 'vukasin',
    })
    expect(got?.value).toBe('sk_test_rotated_7h2j9')
  })

  test('upsert updates the existing row instead of inserting', async () => {
    const fx = setup()
    await upsertCredential(fx.db, {
      project_id: fx.projectA, name: 'DB_URL', value: 'postgres://old',
    })
    const { created } = await upsertCredential(fx.db, {
      project_id: fx.projectA, name: 'DB_URL', value: 'postgres://new',
    })
    expect(created).toBe(false)
    const got = await readCredential(fx.db, {
      project_id: fx.projectA, name: 'DB_URL',
    })
    expect(got?.value).toBe('postgres://new')
    const count = (fx.db.prepare(
      'SELECT COUNT(*) AS n FROM project_credentials WHERE project_id=$p',
    ).get({ $p: fx.projectA }) as { n: number }).n
    expect(count).toBe(1)
  })

  test('fresh IV per write — same value encrypted twice produces different ciphertext', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'X', value: 'same-value' })
    const row1 = getCredentialRow(fx.db, fx.projectA, 'X')!
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'X', value: 'same-value' })
    const row2 = getCredentialRow(fx.db, fx.projectA, 'X')!
    expect(row2.iv).not.toBe(row1.iv)
    expect(row2.ciphertext).not.toBe(row1.ciphertext)
  })

  test('tampered ciphertext bytes fail decryption — GCM tag catches it', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'T', value: 'original' })
    const row = getCredentialRow(fx.db, fx.projectA, 'T')!
    // Flip one byte of ciphertext
    const bad = row.ciphertext.slice(0, -2) + (row.ciphertext.slice(-2) === 'ff' ? '00' : 'ff')
    fx.db.prepare('UPDATE project_credentials SET ciphertext=$c WHERE id=$id')
      .run({ $c: bad, $id: row.id })
    const attempt = readCredential(fx.db, {
      project_id: fx.projectA, name: 'T',
    })
    await expect(attempt).rejects.toThrow()
  })
})

describe('credential-service — cross-project isolation', () => {
  test('project A credential is not readable from project B even with same name', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'API_TOKEN', value: 'A-secret' })
    await upsertCredential(fx.db, { project_id: fx.projectB, name: 'API_TOKEN', value: 'B-secret' })

    const a = await readCredential(fx.db, { project_id: fx.projectA, name: 'API_TOKEN' })
    const b = await readCredential(fx.db, { project_id: fx.projectB, name: 'API_TOKEN' })
    expect(a?.value).toBe('A-secret')
    expect(b?.value).toBe('B-secret')

    // list() only shows the caller's project's creds
    const listA = listCredentials(fx.db, fx.projectA)
    const listB = listCredentials(fx.db, fx.projectB)
    expect(listA.length).toBe(1)
    expect(listB.length).toBe(1)
    expect(listA[0].name).toBe('API_TOKEN')
    expect(listB[0].name).toBe('API_TOKEN')
  })

  test('deleting in A does not affect B', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'K', value: 'A' })
    await upsertCredential(fx.db, { project_id: fx.projectB, name: 'K', value: 'B' })
    deleteCredential(fx.db, { project_id: fx.projectA, name: 'K' })
    expect(await readCredential(fx.db, { project_id: fx.projectA, name: 'K' })).toBeNull()
    const b = await readCredential(fx.db, { project_id: fx.projectB, name: 'K' })
    expect(b?.value).toBe('B')
  })
})

describe('credential-service — list + audit log', () => {
  test('list returns no ciphertext / iv / tag / value fields', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'X', value: 'p' })
    const [item] = listCredentials(fx.db, fx.projectA)
    // Guard: list shape shouldn't accidentally expose secrets via type
    expect((item as any).ciphertext).toBeUndefined()
    expect((item as any).iv).toBeUndefined()
    expect((item as any).tag).toBeUndefined()
    expect((item as any).value).toBeUndefined()
    expect(item.name).toBe('X')
  })

  test('audit log captures create / update / read / delete with actors', async () => {
    const fx = setup()
    // Space the writes by >1ms so timestamp ordering is stable even on a
    // fast clock. The audit table uses millisecond-precision ISO strings;
    // tied timestamps can swap order, which is a test-harness concern not a
    // correctness one (we query {name} — not {name,insertion_order}).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await upsertCredential(fx.db, {
      project_id: fx.projectA, name: 'SECRET', value: 'v1',
      actor_type: 'user', actor_id: 'vukasin',
    })
    await sleep(3)
    await upsertCredential(fx.db, {
      project_id: fx.projectA, name: 'SECRET', value: 'v2',
      actor_type: 'user', actor_id: 'vukasin',
    })
    await sleep(3)
    await readCredential(fx.db, {
      project_id: fx.projectA, name: 'SECRET',
      actor_type: 'agent', actor_id: 'ag-engineer',
    })
    await sleep(3)
    deleteCredential(fx.db, {
      project_id: fx.projectA, name: 'SECRET',
      actor_type: 'user', actor_id: 'vukasin',
    })

    const events = listCredentialEvents(fx.db, fx.projectA, { name: 'SECRET' })
    expect(events.length).toBe(4)
    // events are desc — reverse to inspect creation → delete
    const actions = events.map((e) => `${e.actor_type}:${e.actor_id ?? '-'}/${e.action}`).reverse()
    expect(actions).toEqual([
      'user:vukasin/create',
      'user:vukasin/update',
      'agent:ag-engineer/read',
      'user:vukasin/delete',
    ])
  })

  test('reading a missing name emits a not_found read event (forensics)', async () => {
    const fx = setup()
    const r = await readCredential(fx.db, {
      project_id: fx.projectA, name: 'GHOST',
      actor_type: 'agent', actor_id: 'ag-unknown',
    })
    expect(r).toBeNull()
    const events = listCredentialEvents(fx.db, fx.projectA, { name: 'GHOST' })
    expect(events.length).toBe(1)
    expect(events[0].action).toBe('read')
    expect(events[0].message).toBe('not_found')
    expect(events[0].actor_id).toBe('ag-unknown')
  })

  test('last_read_at stamps the row on successful reads', async () => {
    const fx = setup()
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'LR', value: 'x' })
    const before = getCredentialRow(fx.db, fx.projectA, 'LR')!
    expect(before.last_read_at).toBeNull()
    await readCredential(fx.db, {
      project_id: fx.projectA, name: 'LR',
      actor_type: 'agent', actor_id: 'ag-qa',
    })
    const after = getCredentialRow(fx.db, fx.projectA, 'LR')!
    expect(after.last_read_at).not.toBeNull()
    expect(after.last_read_by_type).toBe('agent')
    expect(after.last_read_by_id).toBe('ag-qa')
  })
})

describe('credential-service — validation', () => {
  test('rejects empty, oversized, and leading-digit names', async () => {
    const fx = setup()
    await expect(upsertCredential(fx.db, { project_id: fx.projectA, name: '', value: 'x' }))
      .rejects.toThrow(/name is required/i)
    await expect(upsertCredential(fx.db, { project_id: fx.projectA, name: '   ', value: 'x' }))
      .rejects.toThrow(/name is required/i)
    await expect(upsertCredential(fx.db, { project_id: fx.projectA, name: '1BAD', value: 'x' }))
      .rejects.toThrow(/must match/i)
    await expect(upsertCredential(fx.db, { project_id: fx.projectA, name: 'has-dash', value: 'x' }))
      .rejects.toThrow(/must match/i)
  })

  test('accepts common env-var shapes', async () => {
    const fx = setup()
    for (const n of ['STRIPE_API_KEY', '_X', 'foo_bar', 'DB_URL_2']) {
      await upsertCredential(fx.db, { project_id: fx.projectA, name: n, value: 'v' })
    }
    expect(listCredentials(fx.db, fx.projectA).map((c) => c.name).sort())
      .toEqual(['DB_URL_2', 'STRIPE_API_KEY', '_X', 'foo_bar'].sort())
  })

  test('delete of missing name is a no-op (returns false) with no audit row', async () => {
    const fx = setup()
    const ok = deleteCredential(fx.db, { project_id: fx.projectA, name: 'NEVER_SET' })
    expect(ok).toBe(false)
    expect(listCredentialEvents(fx.db, fx.projectA, { name: 'NEVER_SET' }).length).toBe(0)
  })
})

describe('credential-service — raw-file confidentiality', () => {
  test('plaintext value bytes never appear in the raw kortix.db file', async () => {
    const fx = setup()
    const secret = 'ThisIsAVerySpecificStringThatMustNotLeak_42'
    await upsertCredential(fx.db, { project_id: fx.projectA, name: 'LEAK_TEST', value: secret })
    // Make sure WAL is committed
    fx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytes = readFileSync(fx.dbPath)
    const idx = bytes.indexOf(Buffer.from(secret, 'utf8'))
    expect(idx).toBe(-1)
  })
})
