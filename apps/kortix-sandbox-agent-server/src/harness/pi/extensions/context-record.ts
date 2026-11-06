/**
 * kortix-context-record: retrieval instead of compaction, on the session log.
 *
 * pi compacts a root session when its context nears the window, when a
 * request overflows it, and on `/compact` (`POST /session/:id/summarize`).
 * Its own compaction is a model call over the whole session that writes a
 * lossy summary. This extension answers pi's `session_before_compact` hook for
 * all three triggers with a reset and makes no model call:
 *
 * - The source: the session log the API stores (`GET .../sessions/:id/log`),
 *   which the box journals at every turn end and every 5 s during a turn.
 *   `kortix sessions log <id>` reads it, plus the open turn live from this box.
 *   Nothing is copied into a file.
 * - The reset: a compaction that keeps no earlier entry (no `firstKeptEntryId`:
 *   pi's `appendCompaction` then keeps none). Its text tells the model how to
 *   read the log and repeats the person's latest message.
 *
 * Without a session id (no API: a local daemon) the hook steps aside and pi
 * compacts with its own summary.
 *
 * The wire, the turn relay, the session log and the restore see an ordinary
 * pi compaction (`fromExtension: true`, `details.kind: 'record'`).
 */

import type { CompactionResult, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'

import { logger } from '@/lib/log/logger'

/** The `details` of a compaction this extension appended. */
export interface ContextRecordDetails {
  kind: 'record'
  /** The Kortix session whose log holds everything before the reset. */
  session: string
  /** Messages in the branch when the reset happened. */
  entries: number
}

/** Characters of the person's latest message the reset text repeats; the log holds the rest. */
export const LATEST_MESSAGE_MAX_CHARS = 8_000

type Block = { type?: string; text?: string }

/** The text of a user message: its text blocks. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
}

/** The branch's message count and the person's latest message. */
export function branchFacts(entries: readonly SessionEntry[]): { count: number; latestUser: string | null } {
  let count = 0
  let latestUser: string | null = null
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message as unknown as { role: string; content?: unknown }
    if (message.role === 'system') continue
    count++
    if (message.role === 'user') latestUser = userText(message.content)
  }
  return { count, latestUser }
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
export function resetText(input: { session: string; count: number; latestUser: string | null; midTurn: boolean }): string {
  const lines = [
    'You are continuing this conversation in a fresh context. Nothing was summarized.',
    `Everything before this point (${input.count} messages, every tool call and result) is this session's log. Read it with \`kortix sessions log ${input.session} -n 50 --json\`: newest last; raise -n to go further back, pipe to jq or rg to search.`,
    'Read the exact lines you need when you need them: an error message, a path, an id, a number, what the person asked for. Never guess what it said, and never copy the log into a file.',
  ]
  if (input.latestUser) {
    const cut = input.latestUser.length > LATEST_MESSAGE_MAX_CHARS
    lines.push(
      "The person's latest message, word for word:",
      `<message>\n${cut ? input.latestUser.slice(0, LATEST_MESSAGE_MAX_CHARS) : input.latestUser}${cut ? '\n(continues in the log)' : ''}\n</message>`,
    )
  }
  if (input.midTurn) lines.push('You were working on it when the context filled. Read the last messages of the log first: they show what you did last and where you stopped.')
  return lines.join('\n')
}

/** The extension. `session()` is the Kortix session id, or null without an API. */
export function contextRecord(host: { session: () => string | null; now?: () => number }): InlineExtension {
  const now = host.now ?? Date.now
  return {
    name: 'kortix-context-record',
    factory: (pi) => {
      pi.on('session_before_compact', (event) => {
        const session = host.session()
        // No log to point at: pi's own summary keeps the session going.
        if (!session) return undefined
        if (event.signal.aborted) return { cancel: true }
        const started = now()
        const facts = branchFacts(event.branchEntries)
        const midTurn = event.willRetry || (event.reason !== 'manual' && endsMidTurn(event.branchEntries))
        const details: ContextRecordDetails = { kind: 'record', session, entries: facts.count }
        const compaction = {
          summary: resetText({ session, count: facts.count, latestUser: facts.latestUser, midTurn }),
          // No first kept entry: pi's `appendCompaction` keeps none (`firstKeptEntryId ?? id`).
          firstKeptEntryId: undefined as unknown as string,
          tokensBefore: event.preparation.tokensBefore,
          details,
        } satisfies CompactionResult<ContextRecordDetails>
        logger.info('[pi] context reset', { reason: event.reason, tokens_before: event.preparation.tokensBefore, entries: facts.count, ms: now() - started })
        return { compaction }
      })
    },
  }
}
