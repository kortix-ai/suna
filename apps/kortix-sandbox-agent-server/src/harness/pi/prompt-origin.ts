/**
 * Where a turn's prompt came from, read from its text. The runtime prompt body
 * carries no origin field (`POST /kortix/runtime/sessions/:id/prompt`), so pi
 * reads the envelope apps/api wraps around every prompt it did not get from a
 * person:
 *
 * | Origin | Envelope | Writer |
 * | --- | --- | --- |
 * | `peer` | `[message from … · session … · #…]` | `peerMessagePromptText` (`@kortix/shared/peer-message-prompt`) |
 * | `room` | `[room … · #…]` | `roomPromptText`, `roomDigestText` (`@kortix/shared/room-prompt`) |
 * | `trigger` | `<trigger_event>` block, or `[REMINDER <id> — …]` | a trigger-started session; a reminder or runtime trigger fire |
 * | `human` | anything else | the person, a parent agent's task, a platform notice |
 *
 * Two features read it, as Claude Code does for its `origin`: the word
 * `ultracode` opts a turn into a workflow only in a `human` prompt, and the
 * `workflow` tool refuses to start in a `peer`, `room` or `trigger` turn.
 */
import { parsePeerMessagePrompt } from '@kortix/shared/peer-message-prompt'
import { parseRoomDigest, parseRoomPrompt } from '@kortix/shared/room-prompt'

export type PromptOrigin = 'human' | 'peer' | 'room' | 'trigger'

/** The head `reminderPromptText` writes (`@kortix/shared/reminder-prompt`). */
const REMINDER_HEAD = /^\[REMINDER (?:reminder|trigger|automation)\.[0-9a-f]{12} — /
/** The tag a trigger-started session's prompt carries (`@kortix/shared/trigger-event`). */
const TRIGGER_EVENT_TAG = '<trigger_event>'

export function promptOrigin(text: string | null | undefined): PromptOrigin {
  const value = text ?? ''
  if (parsePeerMessagePrompt(value)) return 'peer'
  if (parseRoomPrompt(value) || parseRoomDigest(value)) return 'room'
  if (REMINDER_HEAD.test(value) || value.includes(TRIGGER_EVENT_TAG)) return 'trigger'
  return 'human'
}

/** `ultracode` as a word, in any case. */
const ULTRACODE = /\bultracode\b/i

/** The person's own prompt names `ultracode`: this turn runs its task as a workflow. */
export function ultracodeRequested(text: string | null | undefined): boolean {
  return promptOrigin(text) === 'human' && ULTRACODE.test(text ?? '')
}

/** The per-turn system line an `ultracode` prompt adds (`turnExtension`). */
export const ULTRACODE_SYSTEM_LINE =
  'The person wrote "ultracode" in this message: plan and run this task as a workflow (the workflow tool), not turn by turn. ' +
  'Write the script for the task, say in one line what will run, then call workflow. Answer a question that needs no work directly.'

/** Why the workflow tool does not start in a turn of this origin. */
export function workflowOriginRefusal(origin: PromptOrigin): string | null {
  if (origin === 'human') return null
  const from = origin === 'peer' ? 'a message from another session' : origin === 'room' ? 'a room message' : 'a trigger or reminder'
  return `A workflow starts only from a person's own message, and this turn came from ${from}. Do the work with the agent tool, or tell the person a workflow would help and let them start it.`
}
