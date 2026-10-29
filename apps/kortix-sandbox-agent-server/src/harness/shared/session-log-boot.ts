/**
 * When the boot restores a session log (P6.4). Both harnesses call `reconcileSessionLog`
 * before their runtime serves a turn and start the journal with what it returns
 * (`startSessionLogJournal(port, boot)`). When the manifest cannot be read after its retries
 * (no claim has happened yet), a box whose `held()` is not null boots on its native store at
 * its persisted generation and logs one warning; a box without a store throws. A restore that
 * fails after its retries always throws: each attempt may have claimed a generation, so a box
 * that kept its store would post below the claim (409, the journal stops for the boot) and the
 * next healthy boot would restore over that boot's turns. A throw fails the boot, and no
 * journal starts without the cursors `restore` returned.
 *
 * - The flag. apps/api sets `KORTIX_SESSION_LOG_RESTORE=1` when the project flag
 *   `session_log_restore` is on. Off: no manifest read, no restore; the box keeps its native
 *   state and journals at its persisted generation (0 when it never restored) with its persisted
 *   seq offsets (a box that lost its store numbers above the log after the first 422:
 *   `session-log-journal.ts`).
 * - Behind. `GET …/log/manifest` lists every stored message (`deleted` for a tombstone) and the
 *   session generation. The native store is behind the log when the log holds a live message
 *   and (1) the adapter's `held()` is null (no store, no pinned root, a lost seq map), or (2) the
 *   manifest generation is above the one this box persisted (another box claimed the session
 *   and wrote at it), or (3) a live message id is neither held nor one the last restore left
 *   unwritten (a `context` record, which pi and OpenCode rebuild themselves).
 * - Never behind for unsent work. Ids only: a message the native store holds that the log
 *   lacks (a turn not yet journaled), a newer version of a message the log holds, and a
 *   message the store deleted after holding it (a revert not yet tombstoned: `held()` keeps
 *   its id) never make the store behind. Content hashes are not compared: a store with unsent
 *   edits differs from the log by design, and the journal sends the difference.
 * - The restore. Before the first `POST …/log/restore`, `session-log-restore.json` gets a `claiming`
 *   mark. A restore clears it; so does a 404 or 503 to the first attempt (nothing was claimed), and a
 *   later boot whose manifest shows no claim above this box. A 404 or 503 after a failed attempt
 *   settles nothing: that attempt may have claimed. While the mark stands, a manifest that cannot be
 *   read (5xx, network) fails the boot even with a store; one that answers 403, 404 or 503 boots the
 *   store and keeps the mark (the journal has the same gates, so nothing posts below a claim). `POST …/log/restore` claims the next generation; the attachment bytes are
 *   read while the texts are; the adapter writes the log; this box's generation, the ids the
 *   write left out and the D3 notice persist in `session-log-restore.json` in the runtime state
 *   dir, after the write, so a crash mid-write reads as behind at the next boot. A 404 (no
 *   stored log) or 503 (the operator switch is off) claims nothing and restores nothing. Any
 *   other failure is retried: 3 attempts, each a new claim; then the boot fails.
 * - Over the cap. A 413 `session_log_too_large` claimed, and carries the part of the log that fits (`kept`).
 *   The box writes the threads as sent and persists every other stored id (`revs`) as unwritten, so later
 *   boots do not read the store as behind. `model_view`: what the model sees; the cut adds no note and no
 *   `dropped.message` (the writer's own losses still count). `newest`: the newest turns; the D3 note names
 *   the left-out messages, counted as `dropped.message`. No `kept` (an API before it, or nothing fits): the
 *   box writes the log's root with the D3 note alone (above `seq_max`) and keeps no other thread. A 413 with
 *   another body (a proxy) claimed nothing: no restore, as a 404.
 * - D3, a partial restore (the log's grade is `partial`, or the write dropped content, or a
 *   text kept its preview). The agent: a user message with one text block
 *   (`prt_kortix_restore_g<generation>`) after every seq the API holds, under a wire id above
 *   every id of the thread, written into the native store with the log,
 *   so the next request carries it; its cursor entry is dropped, so the journal sends it as the
 *   store holds it and modelView of the log shows it too. Both exports give a message with that
 *   block id prefix `origin: 'notification'` (neither native store keeps an origin). A partial log
 *   that already holds an earlier note gets a new one only when this restore dropped or
 *   truncated something itself. The user: the session patch
 *   `restore_grade: 'partial'` with `grade_counts` and `ext.kortix.data.restore` (generation,
 *   dropped kinds, truncated texts), which the journal sets on every session patch it sends.
 *   ponytail: the adapter writes twice for a partial restore (the drops are known only after
 *   the first write); a dry run of the drops saves the second write when it measures slow.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  SessionLogManifestSchema,
  type ExportCursor,
  type GradeCounts,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogRestore,
  type SessionLogRestoreTooLarge,
  type SessionLogSessionPatch,
  type SessionLogThread,
} from '@kortix/api-contract/session-log'
import { mintWireMessageId } from '@kortix/sdk/wire-message-id'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { sandboxRelayContext, type SandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { logger } from '@/lib/log/logger'
import type { SessionLogPort } from '../contract/session-log'
import { apiBytesReader, apiTextReader, attachmentBytes, sessionLogFromRestore, type TruncatedText } from './session-log-restore'

const ATTEMPTS = 3

/** What the journal starts with: `startSessionLogJournal(port, boot)`. */
export type SessionLogBoot = {
  generation: number
  /** The cursors `restore` returned; empty when nothing was restored. */
  cursors: ExportCursor[]
  /** Set on every session patch the journal sends (D3). */
  session?: SessionLogSessionPatch
  /** The restored log's harness history: the journal keeps it and appends this box's harness when it is another (P7.1). */
  harness?: HarnessCarry
  /** The journal's seq offsets (a 422 moved a thread above the log: `session-log-journal.ts`); a restore clears them. */
  seq_offsets?: Record<string, number>
}

/** The log's harness history at the restore, and the root seq and time from which this box's harness serves the session. */
export type HarnessCarry = { history: SessionLog['harness']['history']; from_seq: number; at: string }

/** `claiming`: a restore POST went out and no answer settled it; the API may hold a claim above `generation`. */
type BootState = { version: 1; generation: number; unwritten: string[]; session?: SessionLogSessionPatch; harness?: HarnessCarry; claiming?: true; seq_offsets?: Record<string, number> }

export const sessionLogBootStatePath = () => join(resolveKortixRuntimeStateDirectory(), 'session-log-restore.json')

function readState(): BootState {
  try {
    const s = JSON.parse(readFileSync(sessionLogBootStatePath(), 'utf8')) as BootState
    if (s.version === 1 && Number.isSafeInteger(s.generation)) return { ...s, unwritten: s.unwritten ?? [] }
  } catch (err) {
    if (existsSync(sessionLogBootStatePath())) logger.warn('[session-log] the restore state does not parse; generation 0', { err: String(err) })
  }
  return { version: 1, generation: 0, unwritten: [] }
}

function writeState(s: BootState): void {
  const path = sessionLogBootStatePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

const kept = (s: BootState): SessionLogBoot => ({
  generation: s.generation,
  cursors: [],
  ...(s.session && { session: s.session }),
  ...(s.harness && { harness: s.harness }),
  ...(s.seq_offsets && { seq_offsets: s.seq_offsets }),
})

/** The journal keeps its seq offsets beside the generation they belong to. A restore writes a state without them. */
export function saveSeqOffsets(seq_offsets: Record<string, number>): void {
  try {
    writeState({ ...readState(), seq_offsets })
  } catch (err) {
    logger.warn('[session-log] could not persist the seq offsets; a restarted daemon learns them again', { err: String(err) })
  }
}

/** No claim above `generation` stands: clear the mark a restore POST left. */
function settled(s: BootState): SessionLogBoot {
  if (s.claiming) {
    const { claiming: _, ...rest } = s
    writeState(rest)
  }
  return kept(s)
}

export async function reconcileSessionLog(port: SessionLogPort, { retryMs = 1_000 } = {}): Promise<SessionLogBoot | null> {
  const ctx = sandboxRelayContext()
  if (!ctx) return null
  const state = readState()
  if (process.env.KORTIX_SESSION_LOG_RESTORE?.trim() !== '1') return kept(state)
  const held = await port.held()
  let manifest: Awaited<ReturnType<typeof readManifest>>
  try {
    manifest = await attempts('manifest', retryMs, () => readManifest(ctx))
  } catch (err) {
    // No claim happens before the manifest: a box with a store boots on it. A box with no store fails, and so
    // does one whose earlier restore POST may have claimed (`claiming`): its store may be below that claim.
    if (!held || state.claiming) throw err
    logger.warn('[session-log] the manifest did not answer; the box keeps its native store', { err: String(err), generation: state.generation })
    return kept(state)
  }
  // A 403/404/503 manifest reads no claim, so it settles none: the mark stays for the first boot that reads one.
  // The journal route has the same gates, so this box cannot post below a claim meanwhile.
  if (!manifest) return kept(state)
  const why = behind(manifest, held, state)
  // A claim that committed raised the manifest generation above this box's, which reads as behind.
  if (!why) return settled(state)
  logger.info('[session-log] the native store is behind the log; restoring', { why, generation: manifest.generation, persisted: state.generation })
  // The mark goes to disk before the first POST: the API commits a claim before it answers, so a box
  // that dies or fails after it must not keep its store at a later boot that cannot read the manifest.
  writeState({ ...state, claiming: true })
  // Each attempt claims a generation before it can fail: a box that kept its store after a failed
  // restore would post below the claim (409) and restore over that boot's turns at the next boot.
  // A 404/503 settles the claim only before any attempt failed: a failed attempt may have claimed.
  let failed = false
  return attempts('restore', retryMs, async () => {
    const boot = await restore(ctx, port).catch((err) => {
      failed = true
      throw err
    })
    if (boot) return boot
    if (failed) throw new Error('restore answered no claim after an attempt that may have claimed')
    return settled({ ...state, claiming: true })
  })
}

async function attempts<T>(what: string, retryMs: number, run: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (err) {
      if (n === ATTEMPTS) throw new Error(`session-log ${what} failed after ${ATTEMPTS} attempts: ${(err as Error).message}`)
      logger.warn(`[session-log] ${what} failed; retrying`, { attempt: n, err: (err as Error).message })
      await Bun.sleep(retryMs * n)
    }
  }
}

const url = (ctx: SandboxRelayContext, path: string) => `${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/log/${path}`

/** The response, or null for an answer that says "no reconcile here" (403, 404, 503, another 4xx); throws on what a retry may fix. */
async function call(ctx: SandboxRelayContext, path: string, method: 'GET' | 'POST'): Promise<Response | null> {
  const response = await fetch(url(ctx, path), {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(path === 'restore' ? 120_000 : 15_000),
  })
  // A 413 to the restore claimed: the answer is the part of the log that fits (`session_log_too_large`).
  if (response.ok || (path === 'restore' && response.status === 413)) return response
  const body = (await response.text().catch(() => '')).slice(0, 200)
  if (response.status >= 500 && response.status !== 503) throw new Error(`${path} answered ${response.status}: ${body}`)
  if (response.status === 408 || response.status === 429) throw new Error(`${path} answered ${response.status}`)
  logger.warn(`[session-log] ${path} answered ${response.status}; no restore`, { body })
  return null
}

async function readManifest(ctx: SandboxRelayContext) {
  const response = await call(ctx, 'manifest', 'GET')
  return response && SessionLogManifestSchema.parse(await response.json())
}

function behind(manifest: { generation: number; messages: Array<{ message_id: string; deleted: boolean }> }, held: ReadonlySet<string> | null, state: BootState): string | null {
  const live = manifest.messages.filter((m) => !m.deleted).map((m) => m.message_id)
  const above = manifest.generation > state.generation ? `generation ${manifest.generation} is above this box's ${state.generation}` : null
  if (live.length === 0) return above
  if (!held) return 'no native store'
  if (above) return above
  const unwritten = new Set(state.unwritten)
  const missing = live.filter((id) => !held.has(id) && !unwritten.has(id))
  return missing.length ? `${missing.length} of ${live.length} messages missing` : null
}

/** Claim, read and write. Null when the API claimed nothing (404, 503). */
async function restore(ctx: SandboxRelayContext, port: SessionLogPort): Promise<SessionLogBoot | null> {
  const response = await call(ctx, 'restore', 'POST')
  if (!response) return null
  const status = response.status
  const answer = (await response.json().catch((err) => (status === 413 ? null : Promise.reject(err)))) as SessionLogRestore | SessionLogRestoreTooLarge | null
  // A 413 from anything but the API (a proxy) reached no claim.
  if (status === 413 && (answer as SessionLogRestoreTooLarge | null)?.error !== 'session_log_too_large') {
    logger.warn('[session-log] restore answered 413 without session_log_too_large; no restore')
    return null
  }
  if (!answer || !Number.isSafeInteger(answer.generation) || !Array.isArray(answer.log?.threads)) throw new Error('the restore answer is not a SessionLogRestore')
  const tooLarge = status === 413 ? (answer as SessionLogRestoreTooLarge) : null
  // Over the cap without `kept`: the root alone, which gets the D3 note; the box keeps no other thread.
  if (tooLarge && !tooLarge.kept) {
    const root = tooLarge.log.threads.find((t) => t.parent_thread_id === null) ?? tooLarge.log.threads[0]
    tooLarge.log.threads = root ? [{ ...root, messages: [] }] : []
    logger.warn('[session-log] the log is over the restore cap; the box boots with the D3 note alone', { generation: answer.generation, bytes: tooLarge.bytes, limit: tooLarge.limit, messages: tooLarge.messages })
  } else if (tooLarge) {
    const kept = tooLarge.log.threads.reduce((n, t) => n + t.messages.length, 0)
    logger.info('[session-log] the log is over the restore cap; the box restores a part of it', { mode: tooLarge.kept, kept, left_out: tooLarge.messages, threads: tooLarge.log.threads.length, generation: answer.generation, bytes: tooLarge.bytes, limit: tooLarge.limit })
  }
  // The cut is a loss only when the model does not get what it saw: not for `model_view`.
  const cut = tooLarge?.kept === 'model_view' ? null : tooLarge
  // Both budgets run at once: the attachment reads do not wait for the texts.
  const bytes = attachmentBytes(answer.log as SessionLog, apiBytesReader(ctx))
  const { log, seq_max, truncated } = await sessionLogFromRestore(answer, apiTextReader(ctx))
  const prefetched = await bytes
  const read = async (ref: string) => prefetched.get(ref) ?? null
  if (log.threads.length === 0) {
    writeState({ version: 1, generation: answer.generation, unwritten: [] })
    return { generation: answer.generation, cursors: [] }
  }
  const root = log.threads.find((t) => t.parent_thread_id === null) ?? log.threads[0]!
  const floor = Math.max(seq_max[root.thread_id] ?? 0, ...root.messages.map((m) => m.seq))
  const harness: HarnessCarry = { history: restoredHistory(log), from_seq: floor + 1, at: new Date().toISOString() }
  let result = await port.restore(log, seq_max, read)
  const dropped = cut ? { ...result.dropped, message: cut.messages } : result.dropped
  let note: SessionLogMessage | null = null
  const notice = partialNotice(log, dropped, truncated, answer.generation, cut)
  // One note per loss: a partial log that already holds an earlier note gets none for the old loss.
  // A `model_view` part may have left that note out, so it gets a note only for its own losses.
  const earlierNote = tooLarge?.kept === 'model_view' || log.threads.some((t) => t.messages.some(isRestoreNote))
  if (notice && (Object.keys(dropped).length > 0 || truncated.length > 0 || !earlierNote)) {
    note = noteMessage(root, floor + 1, answer.generation, notice.text)
    root.messages.push(note)
    result = await port.restore(log, seq_max, read)
  }
  const written = new Set(result.cursors.flatMap((c) => Object.keys(c.native_hashes)))
  // Over the cap, every stored id is unwritten: the next boot does not read the store as behind.
  const ids = tooLarge ? Object.keys(answer.revs) : log.threads.flatMap((t) => t.messages.map((m) => m.message_id))
  const unwritten = ids.filter((id) => !written.has(id))
  // The journal sends the note as the store holds it.
  if (note) for (const c of result.cursors) delete c.native_hashes[note.message_id]
  writeState({ version: 1, generation: answer.generation, unwritten, ...(notice && { session: notice.session }), harness })
  logger.info('[session-log] restored', { generation: answer.generation, threads: result.cursors.length, unwritten: unwritten.length, dropped, truncated: truncated.length })
  return { generation: answer.generation, cursors: result.cursors, ...(notice && { session: notice.session }), harness }
}

/** The stored history; a log without one (a converted log) starts with the harness it names. */
function restoredHistory(log: SessionLog): HarnessCarry['history'] {
  const { current, history } = log.harness ?? { current: '', history: [] }
  if (history?.length) return history
  return current && current !== 'unknown' ? [{ harness: current, version: 'unknown', from_seq: 1, at: log.created_at }] : []
}

/**
 * The harness the journal sends (P7.1). An adapter exports a one-entry history (its own harness);
 * after a restore the journal sends the restored history instead, with one more entry when this box's
 * harness is another than the last one that served the session. A new version of the same harness
 * adds no entry. The entry starts at the first root seq after the restore, so P5.6 draws the switch
 * before the first turn this harness serves.
 */
export function carryHarness(carry: HarnessCarry | undefined, exported: SessionLog['harness']): SessionLog['harness'] {
  const last = carry?.history.at(-1)
  if (!carry || !last) return exported
  if (last.harness === exported.current) return { current: exported.current, history: carry.history }
  const version = exported.history.at(-1)?.version ?? 'unknown'
  return { current: exported.current, history: [...carry.history, { harness: exported.current, version, from_seq: carry.from_seq, at: carry.at }] }
}

/**
 * A D3 note is the message whose text block id starts with this prefix (`prt_kortix_restore_g<generation>`):
 * both stores keep a part id unchanged, so both exports find it and give it `origin: 'notification'`.
 */
export const RESTORE_NOTE_BLOCK_PREFIX = 'prt_kortix_restore_g'
export const isRestoreNote = (m: { blocks: ReadonlyArray<{ id: string }> }) => m.blocks.some((b) => b.id.startsWith(RESTORE_NOTE_BLOCK_PREFIX))

/**
 * The note's id is a wire id minted as a client prompt's is (`mintWireMessageId`, above every id of the
 * thread), so hosts that order placed messages by id show it after the restored history and before
 * the next turn.
 */
function noteMessage(thread: SessionLogThread, seq: number, generation: number, text: string): SessionLogMessage {
  const at = new Date().toISOString()
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: mintWireMessageId({ after: thread.messages.map((m) => m.message_id) }), thread_id: thread.thread_id, seq,
    role: 'user', kind: 'turn', status: 'complete', in_context: true, origin: 'notification',
    model: null, usage: null, finish: null, error: null, created_at: at, completed_at: at,
    producer: { harness: 'kortix', harness_version: 'restore', adapter_version: '1' },
    blocks: [{ type: 'text', id: `${RESTORE_NOTE_BLOCK_PREFIX}${generation}`, text }],
  }
}

const NOUNS: Record<string, [string, string]> = {
  attachment: ['attachment', 'attachments'],
  text: ['long text', 'long texts'],
  tool_input: ['tool input', 'tool inputs'],
  tool_result: ['tool result', 'tool results'],
  layout: ['compacted section', 'compacted sections'],
  cut_point: ['compaction cut point', 'compaction cut points'],
}

/** The D3 notice of a partial restore, or null when the restore is complete. */
function partialNotice(log: SessionLog, dropped: Record<string, number>, truncated: TruncatedText[], generation: number, tooLarge: SessionLogRestoreTooLarge | null) {
  if (log.restore_grade !== 'partial' && Object.keys(dropped).length === 0 && truncated.length === 0) return null
  const prior = log.grade_counts ?? { tool_input: 0, cut_point: 0, attachment: 0 }
  const grade_counts: GradeCounts = {
    tool_input: prior.tool_input + (dropped.tool_input ?? 0),
    cut_point: prior.cut_point + (dropped.layout ?? 0) + (dropped.cut_point ?? 0),
    attachment: prior.attachment + (dropped.attachment ?? 0),
  }
  const counts: Record<string, number> = { ...dropped, text: (dropped.text ?? 0) + truncated.length }
  for (const k of ['tool_input', 'cut_point', 'attachment'] as const) if (prior[k]) counts[k] = (counts[k] ?? 0) + prior[k]
  const items = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(NOUNS[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
  const size = (n: number) => (n >= 1024 ** 2 ? `${+(n / 1024 ** 2).toFixed(1)} MiB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KiB` : `${n} bytes`)
  const text =
    'Kortix: this session was restored from its saved session log. ' +
    (tooLarge?.kept === 'newest'
      ? `Its ${tooLarge.messages} earliest messages were not restored: the conversation (${size(tooLarge.bytes)}) is above the ${size(tooLarge.limit)} restore limit, and the newest messages that fit were restored. `
      : tooLarge
        ? `Its earlier conversation (${tooLarge.messages} messages, ${size(tooLarge.bytes)}) is above the ${size(tooLarge.limit)} restore limit and was not restored. `
        : `Some earlier content could not be restored${items.length ? `: ${items.join(', ')}` : ''}. `) +
    'If you need it, ask the user to send it again.'
  return {
    text,
    session: { restore_grade: 'partial', grade_counts, ext: { kortix: { version: '1', data: { restore: { generation, dropped, truncated: truncated.length } } } } } satisfies SessionLogSessionPatch,
  }
}
