/**
 * first-prompt-seed — the project-home send's first prompt, written into the
 * sync store as an optimistic user message before the thread mounts
 * (COR-185).
 *
 * Without it, `SessionPage` mounts on an empty transcript: the loading page's
 * bubble disappears, the fresh-session hero shows, and the bubble comes back
 * only when the server echo lands. With it, the thread's first frame already
 * holds the prompt and a busy row.
 *
 * The server already holds this prompt (`initial_prompt`, `pending_prompt`,
 * or the warm claim), so the seed never gets "Try again": a client re-send
 * through `prompt_async` would send it twice. The echo replaces the seed
 * through the ordinary optimistic swap (`sync-store.ts` `hydrate`,
 * `event-stream.ts` `message.updated`). Pure, so `bun test` runs it.
 */
import type { MessageWithParts } from '../opencode/types';
import type { AttachedFile } from './attachments';
import { optimisticUserParts } from './optimistic-parts';
import { mintWireMessageId } from './wire-message-id';

/**
 * How long the seeded busy row may wait for a sign of the prompt (the real
 * user message or any reply) before it clears. The seed itself stays.
 */
export const SEED_BUSY_WATCHDOG_MS = 30_000;

export function firstPromptSeed(i: {
  text: string;
  files: AttachedFile[];
  /** The OpenCode root id the thread and SSE use — never the Kortix `session_id`. */
  opencodeSessionId: string;
  /** Ids the store already holds for this root. Any id means no seed. */
  knownMessageIds: string[];
  nowMs: number;
}): MessageWithParts | null {
  const text = i.text.trim();
  if (!text && i.files.length === 0) return null;
  // The store already holds this root (a reopen, or the echo won the race).
  if (i.knownMessageIds.length > 0) return null;

  const parts = optimisticUserParts(text, i.files, i.nowMs);

  return {
    info: {
      id: mintWireMessageId({ nowMs: i.nowMs, knownMessageIds: i.knownMessageIds }),
      role: 'user',
      sessionID: i.opencodeSessionId,
      time: { created: i.nowMs },
    },
    parts,
  };
}

/**
 * True while nothing but the seed is in the transcript: no real user message
 * and no reply yet. An empty or missing list counts as undelivered.
 */
export function seedUndelivered(messages: MessageWithParts[] | undefined, seedId: string): boolean {
  return (messages ?? []).every((message) => message.info.id === seedId);
}
