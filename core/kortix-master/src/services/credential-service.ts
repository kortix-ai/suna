/**
 * Project-scoped credentials — per-project encrypted secret store.
 *
 * Motivation: before this, agents resolved env vars by walking
 *   process.env → <project>/.env → /workspace/.env — all workspace-global.
 * A secret set for project A was visible to project B's agents. That's
 * the thing this service replaces.
 *
 * Design:
 *   - Values encrypted with AES-256-GCM. Fresh 96-bit IV per row. Auth tag
 *     stored + verified on decrypt.
 *   - Dedicated key file at `/persistent/secrets/.credentials-key` (32 bytes
 *     hex). Generated on first use, mode 0600. Independent from SecretStore's
 *     key so rotation cycles don't couple.
 *   - `project_credentials` rows stamped with `UNIQUE(project_id, name)`.
 *     Agents in project A cannot read project B's creds — enforced by the
 *     project_id filter on every query.
 *   - Audit log (`project_credential_events`) writes on create/update/read/
 *     delete, forensics keep what name was accessed even after delete.
 *
 * Secrets never enter process.env or the s6 env dir. Agents get them per-call
 * via the `credential_get` tool, so every read is attributable + revokable.
 */

import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ActorType } from './ticket-service'

// ─── Key management ──────────────────────────────────────────────────────────

function credentialKeyPath(): string {
  if (process.env.CREDENTIAL_KEY_PATH) return process.env.CREDENTIAL_KEY_PATH
  const root = process.env.KORTIX_PERSISTENT_ROOT || '/persistent'
  return join(root, 'secrets', '.credentials-key')
}

let _cachedKey: Buffer | null = null

/** Load (or generate on first use) the 32-byte AES key. Kept in-process
 *  so per-call encrypt/decrypt don't re-read the file. */
async function getKey(): Promise<Buffer> {
  if (_cachedKey) return _cachedKey
  const p = credentialKeyPath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(p)) {
    const hex = (await readFile(p, 'utf8')).trim()
    _cachedKey = Buffer.from(hex, 'hex')
    if (_cachedKey.length !== 32) {
      throw new Error(`credential key at ${p} is ${_cachedKey.length} bytes; must be 32`)
    }
    return _cachedKey
  }
  _cachedKey = randomBytes(32)
  await writeFile(p, _cachedKey.toString('hex'), { mode: 0o600 })
  return _cachedKey
}

/** For tests / rotation — drop the cached key so next call re-loads. */
export function _resetCredentialKeyCache(): void {
  _cachedKey = null
}

// ─── Crypto primitives ───────────────────────────────────────────────────────

interface Cipher {
  ciphertext: string  // hex
  iv: string          // hex
  tag: string         // hex
}

async function encryptValue(plaintext: string): Promise<Cipher> {
  const key = await getKey()
  const iv = randomBytes(12)  // GCM-standard 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ct.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  }
}

async function decryptValue(c: Cipher): Promise<string> {
  const key = await getKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(c.tag, 'hex'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(c.ciphertext, 'hex')),
    decipher.final(),
  ])
  return pt.toString('utf8')
}

// ─── Row shapes ──────────────────────────────────────────────────────────────

export interface CredentialRow {
  id: string
  project_id: string
  name: string
  ciphertext: string
  iv: string
  tag: string
  description: string | null
  created_by_type: ActorType
  created_by_id: string | null
  created_at: string
  updated_at: string
  last_read_at: string | null
  last_read_by_type: ActorType | null
  last_read_by_id: string | null
}

export interface CredentialListItem {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  last_read_at: string | null
}

export interface CredentialEventRow {
  id: string
  project_id: string
  credential_id: string | null
  credential_name: string
  actor_type: ActorType
  actor_id: string | null
  action: string
  message: string | null
  created_at: string
}

export type CredentialAction = 'create' | 'update' | 'read' | 'delete'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genId(): string {
  return 'cred-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function genEventId(): string {
  return 'ce-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Validate a credential name — same rules as env vars so agents can
 *  treat them identically. Letters, digits, underscore; cannot start with
 *  a digit. Empty / too-long rejected. */
function validateName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('credential name is required')
  const n = name.trim()
  if (!n) throw new Error('credential name is required')
  if (n.length > 120) throw new Error('credential name is too long (max 120)')
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(n)) {
    throw new Error('credential name must match /^[A-Z_][A-Z0-9_]*$/i (letters, digits, underscore; no leading digit)')
  }
}

function recordEvent(db: Database, input: {
  projectId: string
  credentialId: string | null
  credentialName: string
  actorType: ActorType
  actorId: string | null
  action: CredentialAction
  message?: string | null
}): CredentialEventRow {
  const row: CredentialEventRow = {
    id: genEventId(),
    project_id: input.projectId,
    credential_id: input.credentialId,
    credential_name: input.credentialName,
    actor_type: input.actorType,
    actor_id: input.actorId,
    action: input.action,
    message: input.message ?? null,
    created_at: nowIso(),
  }
  db.prepare(`
    INSERT INTO project_credential_events
      (id, project_id, credential_id, credential_name, actor_type, actor_id, action, message, created_at)
    VALUES ($id, $pid, $cid, $cn, $at, $ai, $a, $m, $now)
  `).run({
    $id: row.id, $pid: row.project_id, $cid: row.credential_id,
    $cn: row.credential_name, $at: row.actor_type, $ai: row.actor_id,
    $a: row.action, $m: row.message, $now: row.created_at,
  })
  return row
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface UpsertCredentialInput {
  project_id: string
  name: string
  value: string
  description?: string | null
  actor_type?: ActorType
  actor_id?: string | null
}

/** Create or update a project-scoped credential. Re-encrypts on every write
 *  (new IV + tag). Emits `create` or `update` event. Value is never logged. */
export async function upsertCredential(
  db: Database,
  input: UpsertCredentialInput,
): Promise<{ row: CredentialRow; created: boolean }> {
  validateName(input.name)
  if (typeof input.value !== 'string') throw new Error('credential value must be a string')
  const name = input.name.trim()
  const cipher = await encryptValue(input.value)
  const now = nowIso()
  const actorType = input.actor_type ?? 'user'
  const actorId = input.actor_id ?? null

  const existing = db.prepare(
    'SELECT id FROM project_credentials WHERE project_id=$pid AND name=$n',
  ).get({ $pid: input.project_id, $n: name }) as { id: string } | null

  if (existing) {
    db.prepare(`
      UPDATE project_credentials
         SET ciphertext=$ct, iv=$iv, tag=$tag,
             description=$d, updated_at=$now
       WHERE id=$id
    `).run({
      $ct: cipher.ciphertext, $iv: cipher.iv, $tag: cipher.tag,
      $d: input.description ?? null, $now: now, $id: existing.id,
    })
    recordEvent(db, {
      projectId: input.project_id,
      credentialId: existing.id,
      credentialName: name,
      actorType, actorId,
      action: 'update',
      message: input.description ? 'description set' : null,
    })
    return { row: getCredentialRowById(db, existing.id)!, created: false }
  }

  const id = genId()
  db.prepare(`
    INSERT INTO project_credentials
      (id, project_id, name, ciphertext, iv, tag, description,
       created_by_type, created_by_id, created_at, updated_at,
       last_read_at, last_read_by_type, last_read_by_id)
    VALUES ($id, $pid, $n, $ct, $iv, $tag, $d,
            $cbt, $cbi, $now, $now, NULL, NULL, NULL)
  `).run({
    $id: id, $pid: input.project_id, $n: name,
    $ct: cipher.ciphertext, $iv: cipher.iv, $tag: cipher.tag,
    $d: input.description ?? null, $cbt: actorType, $cbi: actorId, $now: now,
  })
  recordEvent(db, {
    projectId: input.project_id,
    credentialId: id,
    credentialName: name,
    actorType, actorId,
    action: 'create',
  })
  return { row: getCredentialRowById(db, id)!, created: true }
}

export function getCredentialRowById(db: Database, id: string): CredentialRow | null {
  return db.prepare('SELECT * FROM project_credentials WHERE id=$id')
    .get({ $id: id }) as CredentialRow | null
}

export function getCredentialRow(db: Database, projectId: string, name: string): CredentialRow | null {
  return db.prepare(
    'SELECT * FROM project_credentials WHERE project_id=$pid AND name=$n',
  ).get({ $pid: projectId, $n: name }) as CredentialRow | null
}

/** List (names + metadata only, NEVER values). */
export function listCredentials(db: Database, projectId: string): CredentialListItem[] {
  return db.prepare(`
    SELECT id, name, description, created_at, updated_at, last_read_at
      FROM project_credentials
     WHERE project_id=$pid
     ORDER BY name ASC
  `).all({ $pid: projectId }) as CredentialListItem[]
}

/** Read + decrypt. Emits a `read` event and stamps last_read_* on the row. */
export async function readCredential(db: Database, opts: {
  project_id: string
  name: string
  actor_type?: ActorType
  actor_id?: string | null
}): Promise<{ row: CredentialRow; value: string } | null> {
  const row = getCredentialRow(db, opts.project_id, opts.name)
  if (!row) {
    recordEvent(db, {
      projectId: opts.project_id,
      credentialId: null,
      credentialName: opts.name,
      actorType: opts.actor_type ?? 'user',
      actorId: opts.actor_id ?? null,
      action: 'read',
      message: 'not_found',
    })
    return null
  }
  const value = await decryptValue(row)
  const now = nowIso()
  db.prepare(`
    UPDATE project_credentials
       SET last_read_at=$now, last_read_by_type=$at, last_read_by_id=$ai
     WHERE id=$id
  `).run({ $now: now, $at: opts.actor_type ?? 'user', $ai: opts.actor_id ?? null, $id: row.id })
  recordEvent(db, {
    projectId: opts.project_id,
    credentialId: row.id,
    credentialName: row.name,
    actorType: opts.actor_type ?? 'user',
    actorId: opts.actor_id ?? null,
    action: 'read',
  })
  return { row: { ...row, last_read_at: now, last_read_by_type: opts.actor_type ?? 'user', last_read_by_id: opts.actor_id ?? null }, value }
}

/** Decrypt without touching audit / last_read — for admin reveal paths that
 *  separately log. Returns null if not found. Use sparingly. */
export async function peekCredentialValue(db: Database, projectId: string, name: string): Promise<string | null> {
  const row = getCredentialRow(db, projectId, name)
  if (!row) return null
  return decryptValue(row)
}

export function deleteCredential(db: Database, opts: {
  project_id: string
  name: string
  actor_type?: ActorType
  actor_id?: string | null
}): boolean {
  const row = getCredentialRow(db, opts.project_id, opts.name)
  if (!row) return false
  db.prepare('DELETE FROM project_credentials WHERE id=$id').run({ $id: row.id })
  recordEvent(db, {
    projectId: opts.project_id,
    credentialId: row.id,
    credentialName: row.name,
    actorType: opts.actor_type ?? 'user',
    actorId: opts.actor_id ?? null,
    action: 'delete',
  })
  return true
}

export function listCredentialEvents(
  db: Database,
  projectId: string,
  opts: { name?: string; limit?: number } = {},
): CredentialEventRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  if (opts.name) {
    return db.prepare(`
      SELECT * FROM project_credential_events
       WHERE project_id=$pid AND credential_name=$n
       ORDER BY created_at DESC
       LIMIT $lim
    `).all({ $pid: projectId, $n: opts.name, $lim: limit }) as CredentialEventRow[]
  }
  return db.prepare(`
    SELECT * FROM project_credential_events
     WHERE project_id=$pid
     ORDER BY created_at DESC
     LIMIT $lim
  `).all({ $pid: projectId, $lim: limit }) as CredentialEventRow[]
}

// ─── Low-level exports for tests + rotation tooling ──────────────────────────

export { encryptValue as _encryptValue, decryptValue as _decryptValue, getKey as _getCredentialKey }
