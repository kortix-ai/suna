/**
 * Local transcript cache — the reason a session can paint before its sandbox
 * is awake.
 *
 * Reading a transcript used to be gated on booting a VM: the messages live on
 * the opencode runtime *inside* the session's sandbox, reachable only through
 * `/p/{externalId}/…`, so opening a hibernated session meant waiting out the
 * whole `/start` wake before a single word appeared. The transcript is already
 * settled history; it does not need a running machine to be shown.
 *
 * So: mirror the tail into IndexedDB as it arrives, and hydrate straight back
 * out of it on open. The live runtime still reconciles behind it — this only
 * changes WHEN the user sees what is already theirs, never what is true.
 */

import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { loadSessionFromIDB, saveSessionToIDB } from '../cache/idb-sync-cache';

export interface CachedTranscript {
  messages: Message[];
  parts: Record<string, Part[]>;
}

interface TranscriptStoreSlice {
  messages: Record<string, Message[]>;
  parts: Record<string, Part[]>;
}

/**
 * Pull one session's messages, plus only the parts belonging to them, out of
 * the (globally part-keyed) sync store. Returns null when there is nothing
 * worth persisting — an absent session and an empty one are the same to a
 * cache whose entire job is having something to show.
 */
export function selectSessionTranscript(
  state: TranscriptStoreSlice,
  sessionId: string,
): CachedTranscript | null {
  const messages = state.messages[sessionId];
  if (!messages || messages.length === 0) return null;
  const parts: Record<string, Part[]> = {};
  for (const message of messages) {
    if (!message?.id) continue;
    parts[message.id] = state.parts[message.id] ?? [];
  }
  return { messages, parts };
}

/** Reshape a cached transcript into the `{ info, parts }` rows `hydrate` takes. */
export function toHydrateEntries(
  transcript: CachedTranscript,
): Array<{ info: Message; parts: Part[] }> {
  return (transcript.messages ?? [])
    .filter((message) => !!message?.id)
    .map((message) => ({ info: message, parts: transcript.parts?.[message.id] ?? [] }));
}

/**
 * The cache is a first-paint accelerator, never a source of truth. Once the
 * store holds anything for this session — from SSE, an optimistic send, or a
 * completed reconcile — it outranks whatever is on disk, so hydrating again
 * could only ever move the transcript backwards.
 */
export function shouldHydrateFromCache(input: {
  storeHasSession: boolean;
  cachedMessageCount: number;
}): boolean {
  if (input.storeHasSession) return false;
  return input.cachedMessageCount > 0;
}

/**
 * Read this session's cached transcript. Resolves to null when there is no
 * usable entry — the caller then simply waits for the runtime, exactly as
 * before this cache existed.
 */
export async function readCachedTranscript(
  sessionId: string,
  kortixSessionScope?: string,
): Promise<CachedTranscript | null> {
  const cached = await loadSessionFromIDB(sessionId, kortixSessionScope);
  if (!cached || !Array.isArray(cached.messages) || cached.messages.length === 0) return null;
  return { messages: cached.messages, parts: cached.parts ?? {} };
}

/** Mirror the session's current tail to disk. Debounced inside the IDB layer. */
export function writeCachedTranscript(
  state: TranscriptStoreSlice,
  sessionId: string,
  kortixSessionScope?: string,
): Promise<void> {
  const transcript = selectSessionTranscript(state, sessionId);
  if (!transcript) return Promise.resolve();
  return saveSessionToIDB(sessionId, transcript.messages, transcript.parts, kortixSessionScope);
}
