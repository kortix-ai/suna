/**
 * File-system backed message queue storage.
 *
 * Persists queued messages as JSON files under a data directory so they
 * survive API restarts and browser reloads. Each queue is keyed by
 * sessionId; messages within a session are ordered by their position
 * in the array (first = next to send).
 *
 * Storage layout:
 *   <DATA_DIR>/queue/<sessionId>.json  →  QueuedMessagePersisted[]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QueuedMessagePersisted {
  id: string;
  sessionId: string;
  text: string;
  /** File attachments are NOT persisted (File objects can't be serialised).
   *  The frontend can still display them from its local store while the tab
   *  is open, but after a reload they are gone (files would need to be
   *  re-uploaded). For now we only persist text payloads. */
  timestamp: number;
  /** Number of failed send attempts. Messages reaching MAX_RETRIES are dead-lettered. */
  retryCount?: number;
  /** Earliest epoch-ms at which the message may be retried (exponential backoff). */
  nextRetryAt?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDataDir(): string {
  // Prefer explicit env var, otherwise default to <cwd>/.kortix-data/queue
  const base = process.env.KORTIX_DATA_DIR || resolve(process.cwd(), '.kortix-data');
  const dir = resolve(base, 'queue');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sessionFilePath(sessionId: string): string {
  // Sanitise sessionId for filesystem safety
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolve(getDataDir(), `${safe}.json`);
}

function readSessionFile(sessionId: string): QueuedMessagePersisted[] {
  const path = sessionFilePath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessionFile(sessionId: string, messages: QueuedMessagePersisted[]): void {
  const path = sessionFilePath(sessionId);
  if (messages.length === 0) {
    // Clean up empty files
    try { unlinkSync(path); } catch { /* ignore */ }
    return;
  }
  writeFileSync(path, JSON.stringify(messages, null, 2), 'utf-8');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get all queued messages for a session, ordered by position. */
export function getSessionQueue(sessionId: string): QueuedMessagePersisted[] {
  return readSessionFile(sessionId);
}

/** Get all queued messages across all sessions. */
export function getAllQueues(): QueuedMessagePersisted[] {
  const dir = getDataDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const all: QueuedMessagePersisted[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) all.push(...parsed);
    } catch { /* skip corrupted files */ }
  }
  return all;
}

/** Get all session IDs that have queued messages. */
export function getActiveSessionIds(): string[] {
  const dir = getDataDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessionIds: string[] = [];
  for (const file of files) {
    const id = basename(file, '.json');
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        sessionIds.push(parsed[0].sessionId || id);
      }
    } catch { /* skip */ }
  }
  return sessionIds;
}

/** Add a message to the end of a session's queue. Returns the created message. */
export function enqueue(sessionId: string, text: string, id?: string): QueuedMessagePersisted {
  const messages = readSessionFile(sessionId);
  const msg: QueuedMessagePersisted = {
    id: id || `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    text,
    timestamp: Date.now(),
  };
  messages.push(msg);
  writeSessionFile(sessionId, messages);
  return msg;
}

/** Remove and return the first message in a session's queue (FIFO). */
export function dequeue(sessionId: string): QueuedMessagePersisted | undefined {
  const messages = readSessionFile(sessionId);
  if (messages.length === 0) return undefined;
  const first = messages.shift()!;
  writeSessionFile(sessionId, messages);
  return first;
}

/** Remove a specific message by ID from any session. */
export function remove(messageId: string, sessionId?: string): boolean {
  if (sessionId) {
    const messages = readSessionFile(sessionId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    messages.splice(idx, 1);
    writeSessionFile(sessionId, messages);
    return true;
  }
  // If no sessionId, scan all files
  const dir = getDataDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const sid = basename(file, '.json');
    const messages = readSessionFile(sid);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      messages.splice(idx, 1);
      writeSessionFile(sid, messages);
      return true;
    }
  }
  return false;
}

/** Move a message up (earlier in queue) within its session. */
export function moveUp(messageId: string, sessionId: string): boolean {
  const messages = readSessionFile(sessionId);
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx <= 0) return false;
  [messages[idx - 1], messages[idx]] = [messages[idx], messages[idx - 1]];
  writeSessionFile(sessionId, messages);
  return true;
}

/** Move a message down (later in queue) within its session. */
export function moveDown(messageId: string, sessionId: string): boolean {
  const messages = readSessionFile(sessionId);
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1 || idx >= messages.length - 1) return false;
  [messages[idx], messages[idx + 1]] = [messages[idx + 1], messages[idx]];
  writeSessionFile(sessionId, messages);
  return true;
}

/** Clear all messages for a session. */
export function clearSession(sessionId: string): void {
  writeSessionFile(sessionId, []);
}

/** Replace the entire queue for a session (used for bulk reorder). */
export function setSessionQueue(sessionId: string, messages: QueuedMessagePersisted[]): void {
  writeSessionFile(sessionId, messages);
}
