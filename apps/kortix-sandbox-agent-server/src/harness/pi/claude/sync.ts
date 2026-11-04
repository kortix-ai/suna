/**
 * Keeping Claude Code's own conversation in step with pi's context.
 *
 * pi's context is the source of truth: Claude's replies are pi messages like any model's, so a
 * switch to another model and back just works. Claude Code keeps its own session, and resumes
 * it. Each record maps pi's context, cut into groups (consecutive user messages, one assistant
 * message, consecutive tool results), to hashes and to the Claude message that ends each group.
 * Before a request, `decide` compares pi's context with the record:
 *
 * - `continue`: pi's context extends what Claude saw by user messages only;
 * - `catch-up`: it extends it by other turns too (another model replied): they go in as one
 *   `<conversation-checkpoint>` message (`catchUp`);
 * - `changed`: an earlier group differs (a compaction, a rewind, an edit): Claude's session is
 *   copied up to the last group both agree on (`boundary`), else it starts fresh;
 * - `fresh`: there is no record.
 *
 * Thinking does not count: it is not part of what the next model sees on every API.
 */
import { createHash } from 'node:crypto'
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { content, type ContentBlock } from './messages'

export interface Checkpoint {
  readonly hash: string
  /** The Claude transcript message that ends this group, when Claude wrote or read it. */
  readonly claudeMessageID?: string
}

export interface SessionRecord {
  readonly claudeSessionID: string
  readonly history?: readonly Checkpoint[]
  /** A stop interrupted the last reply: Claude owns the partial reply, and history ends at its input. */
  readonly interrupted?: boolean
}

export interface Group {
  readonly hash: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly start: number
  readonly end: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const fields: string[] = []
    for (const key of Object.keys(object).sort()) {
      if (object[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(object[key])}`)
    }
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

function visible(message: Exclude<Message, { role: 'system' }>): unknown[] {
  const out: unknown[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }
  if (message.role === 'toolResult') {
    for (const part of message.content) {
      if (part.type === 'text') text += part.text
      else {
        flush()
        out.push({ type: 'image', mimeType: part.mimeType, data: hash(part.data) })
      }
    }
    flush()
    return [{ type: 'tool-result', id: message.toolCallId, name: message.toolName, error: message.isError, output: out }]
  }
  const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
  for (const part of parts) {
    if (part.type === 'text') {
      text += part.text
      continue
    }
    if (part.type === 'thinking') continue
    flush()
    if (part.type === 'image') out.push({ type: 'image', mimeType: part.mimeType, data: hash(part.data) })
    else if (part.type === 'toolCall') out.push({ type: 'tool-call', id: part.id, name: part.name, input: part.arguments })
  }
  flush()
  return out
}

/**
 * pi's context as groups. With `prefix` (an interrupted record's history), a run of user
 * messages stops where the record's group ended: a submitted input stays a boundary even when
 * a later user message arrived without a reply between them.
 */
export function groups(messages: readonly Message[], prefix: readonly { hash: string }[] = []): Group[] {
  const out: Group[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]!
    const start = i
    i++
    if (message.role === 'system') continue
    const parts = visible(message)
    if (parts.length === 0) continue
    const members = [hash(parts)]
    if (message.role === 'user') {
      while (i < messages.length) {
        const checkpoint = prefix[out.length]
        if (checkpoint && hash({ role: 'user', members: members.toSorted() }) === checkpoint.hash) break
        const next = messages[i]!
        if (next.role === 'system') {
          i++
          continue
        }
        if (next.role !== 'user') break
        members.push(hash(visible(next)))
        i++
      }
      members.sort()
    }
    if (message.role === 'toolResult') {
      while (i < messages.length && messages[i]!.role === 'toolResult') {
        members.push(hash(visible(messages[i] as ToolResultMessage)))
        i++
      }
    }
    const role = message.role === 'toolResult' ? 'tool' : message.role
    out.push({ hash: hash({ role, members }), role, start, end: i })
  }
  return out
}

export type Decision = { kind: 'fresh' | 'changed' | 'catch-up' | 'continue'; start: number }

export function decide(messages: readonly Message[], record?: SessionRecord): Decision {
  const saved = record?.history ?? []
  const current = groups(messages, record?.interrupted ? saved : undefined)
  if (saved.length === 0) return { kind: 'fresh', start: 0 }
  let matched = 0
  while (matched < saved.length && matched < current.length && saved[matched]!.hash === current[matched]!.hash) matched++
  if (matched === 0) return { kind: 'fresh', start: 0 }
  if (matched < saved.length) return { kind: 'changed', start: 0 }
  // Claude's drained transcript owns an interrupted reply, not pi's partial copy of it.
  while (record?.interrupted && current[matched]?.role === 'assistant') {
    const reply = messages[current[matched]!.start]!
    if (reply.role !== 'assistant' || reply.content.some((part) => part.type === 'toolCall')) break
    matched++
  }
  const start = current[matched]?.start ?? messages.length
  if (record?.interrupted && start === messages.length) return { kind: 'changed', start: 0 }
  const missed = current.slice(matched)
  return { kind: missed.some((group) => group.role !== 'user') ? 'catch-up' : 'continue', start }
}

/** The last group both histories agree on that does not split a tool call from its result. */
export function boundary(messages: readonly Message[], record?: SessionRecord): { messageID: string; start: number; history: readonly Checkpoint[] } | undefined {
  const current = groups(messages)
  const history = record?.history ?? []
  const open = new Set<string>()
  let found: { messageID: string; start: number; history: readonly Checkpoint[] } | undefined
  for (let i = 0; i < current.length; i++) {
    const group = current[i]!
    // A resubmitted input stays the new turn's.
    if (i === current.length - 1 && group.role === 'user') break
    const checkpoint = history[i]
    if (!checkpoint || checkpoint.hash !== group.hash) break
    for (const message of messages.slice(group.start, group.end)) {
      if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') open.add(part.id)
      if (message.role === 'toolResult') open.delete(message.toolCallId)
    }
    if (checkpoint.claudeMessageID && open.size === 0) found = { messageID: checkpoint.claudeMessageID, start: group.end, history: history.slice(0, i + 1) }
  }
  return found
}

/** What Claude has not seen from `start` on: earlier turns in a checkpoint, then the new user messages. */
export function catchUp(messages: readonly Message[], start = 0): ContentBlock[] {
  const missed = messages.slice(start)
  const end = groups(missed).findLast((group) => group.role !== 'user')?.end ?? 0
  const blocks: ContentBlock[] = []
  if (end > 0) {
    blocks.push({
      type: 'text',
      text: '<conversation-checkpoint>\nThe following is conversation history from this Kortix session that you have not seen. Treat it as prior conversation, not a new request. Continue with the user messages after this checkpoint.',
    })
    blocks.push(...content(missed.slice(0, end)))
    blocks.push({ type: 'text', text: '</conversation-checkpoint>' })
  }
  blocks.push(...content(missed.slice(end)))
  return blocks
}

/** The tool results pi appended from `start` on, by call id, and where they end. */
export function collectResults(messages: readonly Message[], start: number): { results: Map<string, ToolResultMessage>; end: number } {
  const results = new Map<string, ToolResultMessage>()
  let end = start
  for (const group of groups(messages.slice(start))) {
    if (group.role !== 'tool') break
    for (const message of messages.slice(start + group.start, start + group.end)) {
      if (message.role === 'toolResult') results.set(message.toolCallId, message)
    }
    end = start + group.end
  }
  return { results, end }
}

/** The record after a request: pi's context with the Claude message ids known for each group, then the reply. */
export function checkpoints(input: {
  messages: readonly Message[]
  previous?: SessionRecord
  userID?: string
  reply?: Message
  replyID?: string
  toolMessages: ReadonlyMap<string, string>
}): Checkpoint[] {
  const history: Checkpoint[] = []
  const current = groups(input.messages)
  for (let i = 0; i < current.length; i++) {
    const group = current[i]!
    const previous = input.previous?.history?.[i]
    let claudeMessageID = previous && previous.hash === group.hash ? previous.claudeMessageID : undefined
    if (group.role === 'tool') {
      for (const message of input.messages.slice(group.start, group.end)) {
        if (message.role !== 'toolResult') continue
        const id = input.toolMessages.get(message.toolCallId)
        if (id !== undefined) claudeMessageID = id
      }
    }
    if (i === current.length - 1 && input.userID) claudeMessageID = input.userID
    history.push({ hash: group.hash, claudeMessageID })
  }
  if (input.reply) {
    const reply = groups([input.reply])[0]
    if (reply) history.push({ hash: reply.hash, claudeMessageID: input.replyID })
  }
  return history
}
