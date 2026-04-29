/**
 * Queue drainer — runs in the background on the backend.
 *
 * Periodically checks all sessions that have queued messages. When a
 * session is idle (not busy), dequeues the next message and sends it
 * to the OpenCode server via prompt_async. This way queued messages
 * are processed even if the user has closed the browser tab.
 *
 * The drainer polls every POLL_INTERVAL_MS. It's intentionally simple
 * (polling, not event-driven) to avoid coupling with the SSE stream
 * and to be resilient to missed events.
 */

import { config } from '../config';
import * as storage from './storage';

// ─── Config ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000; // Check every 2 seconds
const SETTLE_DELAY_MS = 500;   // Wait after idle detected before sending
const PROMPT_TIMEOUT_MS = 30000;

// ─── OpenCode URL resolution ─────────────────────────────────────────────────

function getOpenCodeUrl(): string {
  // Same candidates as setup/index.ts
  const explicit = process.env.OPENCODE_URL || process.env.KORTIX_MASTER_URL;
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, '');

  // Inside docker-compose, the sandbox is reachable at http://sandbox:8000
  // but from host dev, it's localhost:PORT_BASE
  return `http://localhost:${config.SANDBOX_PORT_BASE || 14000}`;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (serviceKey) {
    headers['Authorization'] = `Bearer ${serviceKey}`;
  }
  return headers;
}

// ─── Session status check ────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  status?: { type: string };
  [key: string]: unknown;
}

async function getSessionStatus(sessionId: string): Promise<'busy' | 'idle' | 'unknown'> {
  const url = getOpenCodeUrl();
  try {
    const res = await fetch(`${url}/session/${sessionId}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unknown';
    const session = (await res.json()) as SessionInfo;
    const type = session?.status?.type;
    if (type === 'busy' || type === 'retry') return 'busy';
    return 'idle';
  } catch {
    return 'unknown';
  }
}

// ─── Send prompt ─────────────────────────────────────────────────────────────

async function sendPrompt(sessionId: string, text: string): Promise<boolean> {
  const url = getOpenCodeUrl();
  try {
    const res = await fetch(`${url}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
      }),
      signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
    });
    // prompt_async returns 204 No Content on success
    if (res.ok || res.status === 204) {
      await res.text(); // consume body
      return true;
    }
    const errText = await res.text();
    console.error(`[queue-drainer] prompt_async failed for session ${sessionId}: ${res.status} ${errText}`);
    return false;
  } catch (err) {
    console.error(`[queue-drainer] prompt_async error for session ${sessionId}:`, err);
    return false;
  }
}

// ─── Drain loop ──────────────────────────────────────────────────────────────

// Track which sessions we're currently processing to avoid double-sends
const processingSet = new Set<string>();

async function drainOnce(): Promise<void> {
  const sessionIds = storage.getActiveSessionIds();
  if (sessionIds.length === 0) return;

  for (const sessionId of sessionIds) {
    // Skip if already processing this session
    if (processingSet.has(sessionId)) continue;

    const queue = storage.getSessionQueue(sessionId);
    if (queue.length === 0) continue;

    // Check session status
    const status = await getSessionStatus(sessionId);
    if (status === 'busy') continue;
    if (status === 'unknown') continue; // Don't risk sending if we can't verify

    // Session is idle and has queued messages — dequeue and send
    processingSet.add(sessionId);

    try {
      // Small settle delay
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));

      // Re-check: session might have become busy during settle
      const recheck = await getSessionStatus(sessionId);
      if (recheck !== 'idle') continue;

      // Dequeue
      const msg = storage.dequeue(sessionId);
      if (!msg) continue;

      // Respect exponential backoff: skip if not yet eligible for retry
      if (msg.nextRetryAt && Date.now() < msg.nextRetryAt) {
        // Put it back (at front — it was already dequeued) and skip this cycle
        const current = storage.getSessionQueue(sessionId);
        storage.setSessionQueue(sessionId, [msg, ...current]);
        continue;
      }

      console.log(`[queue-drainer] Sending queued message "${msg.text.slice(0, 60)}..." to session ${sessionId}`);

      const success = await sendPrompt(sessionId, msg.text);
      if (!success) {
        const retryCount = (msg.retryCount ?? 0) + 1;
        const MAX_RETRIES = 5;
        if (retryCount >= MAX_RETRIES) {
          // Dead-letter: drop the message after MAX_RETRIES failures so the
          // drainer doesn't loop forever on an undeliverable message.
          console.error(
            `[queue-drainer] Message ${msg.id} dead-lettered after ${MAX_RETRIES} retries, dropping`
          );
        } else {
          // Exponential backoff: 2^retryCount * POLL_INTERVAL_MS
          const nextRetryAt = Date.now() + Math.pow(2, retryCount) * POLL_INTERVAL_MS;
          const retried = { ...msg, retryCount, nextRetryAt };
          console.warn(
            `[queue-drainer] Failed to send (attempt ${retryCount}/${MAX_RETRIES}), re-queuing ${msg.id} (next retry in ${Math.pow(2, retryCount) * POLL_INTERVAL_MS}ms)`
          );
          const current = storage.getSessionQueue(sessionId);
          storage.setSessionQueue(sessionId, [retried, ...current]);
        }
      }
    } catch (err) {
      console.error(`[queue-drainer] Error processing session ${sessionId}:`, err);
    } finally {
      processingSet.delete(sessionId);
    }
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDrainer(): void {
  if (intervalHandle) return; // Already running
  console.log('[queue-drainer] Starting message queue drainer');
  intervalHandle = setInterval(() => {
    drainOnce().catch((err) => {
      console.error('[queue-drainer] Unexpected error:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopDrainer(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[queue-drainer] Stopped message queue drainer');
  }
}

export function isDrainerRunning(): boolean {
  return intervalHandle !== null;
}
