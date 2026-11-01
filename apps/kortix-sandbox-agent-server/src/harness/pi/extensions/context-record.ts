/**
 * kortix-context-record: retrieval instead of compaction.
 *
 * pi compacts a root session when its context nears the window, when a
 * request overflows it, and on `/compact` (`POST /session/:id/summarize`).
 * Its own compaction is a model call over the whole session that writes a
 * lossy summary. This extension answers pi's `session_before_compact` hook for
 * all three triggers with its own compaction and makes no model call:
 *
 * - The record: every entry of the root thread, word for word, in one file
 *   under the pi state dir (outside `/workspace`, so never in the project repo
 *   or a snapshot). Written at session start (a restored log included), at
 *   every settled run, and inside the hook before it returns.
 * - The reset: a compaction that keeps no earlier entry (no `firstKeptEntryId`:
 *   pi's `appendCompaction` then keeps none). Its text tells the model where the
 *   record is, how to read it, and repeats the person's latest message.
 *
 * The wire, the turn relay, the session log and the restore see an ordinary
 * pi compaction (`fromExtension: true`, `details.kind: 'record'`).
 *
 * Record format (Mainplane's): one JSON header line per entry
 * (`{"n":12,"kind":"result","time":"…",…}`), then the entry's text, then a
 * newline. The header of any line is the nearest line above it that starts
 * with `{"n":`.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompactionResult, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'

import { logger } from '@/lib/log/logger'

/** The `details` of a compaction this extension appended. */
export interface ContextRecordDetails {
  kind: 'record'
  path: string
  /** Entries in the record when the reset happened. */
  entries: number
}

/** Characters of the person's latest message the reset text repeats; the record holds the rest. */
export const LATEST_MESSAGE_MAX_CHARS = 8_000

type Header = { n: number; kind: string; time: string } & Record<string, string | number | boolean>
type Block = { type?: string; text?: string; thinking?: string; redacted?: boolean; data?: string; mimeType?: string; id?: string; name?: string; arguments?: unknown }

const timeOf = (value: unknown): string => {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
}

const imageLine = (block: Block) => `[image: ${block.mimeType ?? 'unknown'}, ${Math.floor(((block.data?.length ?? 0) * 3) / 4)} bytes, not in the record]`

/** The text of message content: text as is, an image as one line, other blocks dropped. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((block) => (block?.type === 'text' ? (block.text ?? '') : block?.type === 'image' ? imageLine(block) : ''))
    .filter(Boolean)
    .join('\n')
}

/** One entry's record items: a message can hold several (an assistant's text, thinking and calls). */
function itemsOf(entry: SessionEntry): Array<{ head: Record<string, string | number | boolean>; body: string }> {
  const time = timeOf(entry.timestamp)
  if (entry.type === 'message') {
    const message = entry.message as unknown as Record<string, unknown> & { role: string; content?: unknown }
    // pi's system prompt entry: the model always has it, so the record leaves it out (as pi's projection does).
    if (message.role === 'system') return []
    if (message.role === 'user') return [{ head: { kind: 'user', time }, body: contentText(message.content) }]
    if (message.role === 'toolResult') {
      return [
        {
          head: { kind: 'result', time, name: String(message.toolName ?? ''), for: String(message.toolCallId ?? ''), exit: message.isError ? 'error' : 'ok' },
          body: contentText(message.content),
        },
      ]
    }
    if (message.role === 'assistant') {
      const items: Array<{ head: Record<string, string | number | boolean>; body: string }> = []
      for (const block of (Array.isArray(message.content) ? message.content : []) as Block[]) {
        if (block?.type === 'text' && block.text?.trim()) items.push({ head: { kind: 'assistant', time }, body: block.text })
        else if (block?.type === 'thinking' && !block.redacted && block.thinking?.trim()) items.push({ head: { kind: 'thinking', time }, body: block.thinking })
        else if (block?.type === 'toolCall') items.push({ head: { kind: 'call', time, name: String(block.name ?? ''), id: String(block.id ?? '') }, body: JSON.stringify(block.arguments ?? {}) })
      }
      if (typeof message.errorMessage === 'string' && message.errorMessage) items.push({ head: { kind: 'error', time }, body: message.errorMessage })
      return items
    }
    if (message.role === 'bashExecution') {
      return [{ head: { kind: 'call', time, name: 'user_bash' }, body: `${String(message.command ?? '')}\n${String(message.output ?? '')}` }]
    }
    return [{ head: { kind: 'event', time, role: message.role }, body: contentText(message.content) }]
  }
  if (entry.type === 'custom_message') return [{ head: { kind: 'event', time, type: entry.customType }, body: contentText(entry.content) }]
  if (entry.type === 'compaction') {
    const details = entry.details as Partial<ContextRecordDetails> | undefined
    return [{ head: { kind: 'reset', time, ...(details?.kind === 'record' ? { mode: 'record' } : { mode: 'summary' }), tokens_before: entry.tokensBefore }, body: details?.kind === 'record' ? '' : entry.summary }]
  }
  if (entry.type === 'branch_summary') return [{ head: { kind: 'event', time, type: 'branch_summary' }, body: entry.summary }]
  if (entry.type === 'model_change') return [{ head: { kind: 'model', time }, body: `${entry.provider}/${entry.modelId}` }]
  return []
}

/** The record of a branch: every entry, word for word, numbered from 1. */
export function renderRecord(entries: readonly SessionEntry[]): { text: string; count: number; latestUser: { n: number; text: string } | null } {
  const parts: string[] = []
  let n = 0
  let latestUser: { n: number; text: string } | null = null
  for (const entry of entries) {
    for (const item of itemsOf(entry)) {
      n++
      const header: Header = { n, ...item.head } as Header
      parts.push(`${JSON.stringify(header)}\n${item.body}\n`)
      if (item.head.kind === 'user') latestUser = { n, text: item.body }
    }
  }
  return { text: parts.join(''), count: n, latestUser }
}

/**
 * Write a file atomically: a temp file in the same dir, then a rename. Dir 0700, file 0600. The dir
 * ignores itself for git, so a state dir inside a checkout never shows the record as a change.
 */
function writeAtomic(path: string, dir: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

/** True when the branch ends inside a tool chain: a reset there continues the same turn. */
export function endsMidTurn(entries: readonly SessionEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type !== 'message') continue
    const message = entry.message as unknown as { role: string; stopReason?: string }
    if (message.role === 'toolResult') return true
    if (message.role === 'assistant') return message.stopReason === 'toolUse'
    return false
  }
  return false
}

/** The text the model reads after a reset (pi wraps it in its compaction framing). */
export function resetText(input: { path: string; count: number; latestUser: { n: number; text: string } | null; midTurn: boolean }): string {
  const lines = [
    'You are continuing this conversation in a fresh context. Nothing was summarized.',
    `The full record of everything before this point is the file ${input.path}: ${input.count} entries, every message, tool call and tool result, word for word. Each entry starts with one JSON header line such as {"n":12,"kind":"result","time":"…"}; the lines after it, up to the next header, are the entry.`,
    'Search it with grep and read the exact lines you need, when you need them: an error message, a path, an id, a number, what the person asked for. Never guess what it said, and never show the person this file or its path.',
  ]
  if (input.latestUser) {
    const text = input.latestUser.text
    const cut = text.length > LATEST_MESSAGE_MAX_CHARS
    lines.push(
      `The person's latest message (entry ${input.latestUser.n}), word for word:`,
      `<message>\n${cut ? text.slice(0, LATEST_MESSAGE_MAX_CHARS) : text}${cut ? `\n(continues in the record at entry ${input.latestUser.n})` : ''}\n</message>`,
    )
  }
  if (input.midTurn) lines.push('You were working on it when the context filled. Read the last entries of the record first: they show what you did last and where you stopped.')
  return lines.join('\n')
}

/**
 * The extension. `dir` is where the record lives (`<piStateDir>/records`); the
 * record is `<dir>/<pi session id>.log`.
 */
export function contextRecord(host: { dir: string; now?: () => number }): InlineExtension {
  const now = host.now ?? Date.now
  const pathFor = (sessionId: string) => join(host.dir, `${sessionId || 'session'}.log`)
  const write = (sessionId: string, entries: readonly SessionEntry[]) => {
    const record = renderRecord(entries)
    const path = pathFor(sessionId)
    writeAtomic(path, host.dir, record.text)
    return { ...record, path, bytes: Buffer.byteLength(record.text) }
  }
  const persist = (sessionId: string, entries: readonly SessionEntry[], when: string) => {
    try {
      write(sessionId, entries)
    } catch (err) {
      logger.warn('[pi] context record write failed', { when, err: (err as Error).message })
    }
  }
  return {
    name: 'kortix-context-record',
    factory: (pi) => {
      pi.on('session_start', (_event, ctx) => persist(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), 'start'))
      pi.on('agent_settled', (_event, ctx) => persist(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), 'settled'))
      pi.on('session_before_compact', (event, ctx) => {
        const started = now()
        let record: ReturnType<typeof write>
        try {
          record = write(ctx.sessionManager.getSessionId(), event.branchEntries)
        } catch (err) {
          // No record, no reset: pi's own summary still keeps the session going.
          logger.warn('[pi] context record write failed; pi compacts with a summary', { reason: event.reason, err: (err as Error).message })
          return undefined
        }
        if (event.signal.aborted) return { cancel: true }
        const midTurn = event.willRetry || (event.reason !== 'manual' && endsMidTurn(event.branchEntries))
        const details: ContextRecordDetails = { kind: 'record', path: record.path, entries: record.count }
        const compaction = {
          summary: resetText({ path: record.path, count: record.count, latestUser: record.latestUser, midTurn }),
          // No first kept entry: pi's `appendCompaction` keeps none (`firstKeptEntryId ?? id`).
          firstKeptEntryId: undefined as unknown as string,
          tokensBefore: event.preparation.tokensBefore,
          details,
        } satisfies CompactionResult<ContextRecordDetails>
        logger.info('[pi] context reset', { reason: event.reason, tokens_before: event.preparation.tokensBefore, entries: record.count, record_bytes: record.bytes, ms: now() - started })
        return { compaction }
      })
    },
  }
}
