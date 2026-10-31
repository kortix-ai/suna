/**
 * A session's prompts the log does not hold yet, as provisional user messages of its thread.
 *
 * A prompt is accepted by the API long before the session log holds it: it waits in the
 * inbox while the box boots or a turn runs, and after delivery the box journals it within
 * seconds. `GET …/prompts` (and `kortix.control.queue`) list both stages: `prompts` (the
 * inbox) and `sent` (accepted, not journaled yet, and the session's `initial_prompt`).
 * `sessionLogThreadWithPrompts` adds each one the thread does not hold as a user message
 * under its own `message_id`, after the log's messages: the log's put of the same id
 * replaces it, so a host never pairs a provisional message with the real one by text or by
 * position. `ext.kortix` marks it (`sessionLogMessageDelivery`).
 */
import type { SessionPrompt, SessionSentPrompt } from '../rest/projects-client/sessions';
import { SESSION_LOG_SCHEMA, type SessionLogBlock, type SessionLogMessage, type SessionLogThread } from './types';

/** Where a provisional prompt is: in the inbox (`queued`), on the wire (`delivering`), or accepted by the runtime (`sent`). */
export type SessionLogPromptDelivery = 'queued' | 'delivering' | 'sent';

/** The `ext` key and version of the provisional mark. */
export const SESSION_LOG_PROMPT_EXT = 'kortix';
export const SESSION_LOG_PROMPT_EXT_VERSION = 'kortix.prompt.v1';

const PRODUCER = { harness: 'kortix-api', harness_version: '1', adapter_version: '1' };

/** The delivery mark of a provisional prompt message; null for a message the log holds. */
export function sessionLogMessageDelivery(message: SessionLogMessage): { delivery: SessionLogPromptDelivery; prompt_id: string | null } | null {
  const ext = message.ext?.[SESSION_LOG_PROMPT_EXT];
  if (!ext || ext.version !== SESSION_LOG_PROMPT_EXT_VERSION) return null;
  const data = ext.data as { delivery?: unknown; prompt_id?: unknown } | undefined;
  const delivery = data?.delivery;
  if (delivery !== 'queued' && delivery !== 'delivering' && delivery !== 'sent') return null;
  return { delivery, prompt_id: typeof data?.prompt_id === 'string' ? data.prompt_id : null };
}

type Provisional = {
  id: string;
  delivery: SessionLogPromptDelivery;
  promptId: string | null;
  text: string;
  attachments: Array<{ filename: string; mime: string }>;
  createdAt: string;
};

function provisional(sessionThreadId: string, entry: Provisional, seq: number): SessionLogMessage {
  const blocks: SessionLogBlock[] = [];
  if (entry.text) blocks.push({ id: `${entry.id}-text`, type: 'text', text: entry.text });
  entry.attachments.forEach((file, i) => blocks.push({ id: `${entry.id}-file-${i}`, type: 'attachment', name: file.filename, mime: file.mime }));
  return {
    schema: SESSION_LOG_SCHEMA,
    v: 1,
    message_id: entry.id,
    thread_id: sessionThreadId,
    seq,
    role: 'user',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    origin: 'prompt',
    model: null,
    usage: null,
    finish: null,
    error: null,
    created_at: entry.createdAt,
    completed_at: null,
    producer: PRODUCER,
    blocks,
    ext: { [SESSION_LOG_PROMPT_EXT]: { version: SESSION_LOG_PROMPT_EXT_VERSION, data: { delivery: entry.delivery, prompt_id: entry.promptId } } },
  };
}

/**
 * `thread` with every prompt in `sent` (oldest first) and then `prompts` (inbox order) that it
 * does not hold, as provisional user messages numbered after its last `seq`. Held: the thread
 * has a message with the prompt's `message_id` or the id it was sent under (`wire_message_id`),
 * or `revs` (the store's revs, tombstones included) names one. A `failed` inbox row stays out:
 * it was never accepted. With no thread yet (a booting session) and something to add, the
 * messages form a new root thread. The thread itself when nothing is added.
 */
export function sessionLogThreadWithPrompts(
  sessionId: string,
  thread: SessionLogThread | null,
  prompts: readonly SessionPrompt[],
  sent: readonly SessionSentPrompt[],
  revs?: Readonly<Record<string, number>>,
): SessionLogThread | null {
  const held = new Set(thread?.messages.map((m) => m.message_id) ?? []);
  const isHeld = (id: string | undefined) => !!id && (held.has(id) || revs?.[id] !== undefined);
  const entries: Provisional[] = [];
  const add = (entry: Provisional, alias?: string) => {
    if (!entry.id || isHeld(entry.id) || isHeld(alias)) return;
    held.add(entry.id);
    entries.push(entry);
  };
  for (const s of [...sent].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    add({ id: s.message_id, delivery: 'sent', promptId: s.prompt_id, text: s.text, attachments: s.attachments, createdAt: s.created_at }, s.wire_message_id ?? undefined);
  }
  for (const p of prompts) {
    if (p.state === 'failed') continue;
    add(
      {
        id: p.message_id || p.wire_message_id || '',
        delivery: p.state === 'delivering' ? 'delivering' : 'queued',
        promptId: p.prompt_id,
        text: p.full_text || p.text,
        attachments: p.attachments ?? [],
        createdAt: p.created_at,
      },
      p.wire_message_id,
    );
  }
  if (!entries.length) return thread;
  const base: SessionLogThread = thread ?? {
    schema: SESSION_LOG_SCHEMA,
    v: 1,
    thread_id: sessionId,
    parent_thread_id: null,
    spawned_by: null,
    agent: null,
    title: null,
    created_at: entries[0]!.createdAt,
    messages: [],
  };
  let seq = base.messages.at(-1)?.seq ?? 0;
  return { ...base, messages: [...base.messages, ...entries.map((e) => provisional(base.thread_id, e, ++seq))] };
}
