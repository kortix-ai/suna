/**
 * Context in use for a thread: the web's rule
 * (`packages/ui/src/session/composer/context-usage.ts`) — the last reply with
 * usage (`sessionLogThreadMetrics(...).context`), counting input, output and
 * cache (reasoning is a subset of output and is not added twice), against the
 * model's context window when one is known. The tray prints it; the info
 * panel too.
 */

import {
  type SessionLogMessage,
  type SessionLogThread,
  sessionLogThreadMetrics,
} from '@kortix/sdk';

export interface ContextReading {
  tokens: number;
  /** The model's window, or null when no source knows it. */
  limit: number | null;
  /** 0–100, or null without a limit. */
  percent: number | null;
}

/** Context in use for `thread`, against `limit`. */
export function contextReading(
  thread: Pick<SessionLogThread, 'messages'> | null | undefined,
  limit: number | null,
): ContextReading {
  const message = thread
    ? (sessionLogThreadMetrics(thread as SessionLogThread).context as SessionLogMessage | null)
    : null;
  const usage = message?.usage;
  const tokens = usage ? usage.input + usage.output + usage.cache_read + usage.cache_write : 0;
  const percent = limit && tokens > 0 ? Math.min(Math.round((tokens / limit) * 100), 100) : null;
  return { tokens, limit, percent };
}

/** The model ref of the reply `contextReading` counts, to look up its window. */
export function contextModel(
  thread: Pick<SessionLogThread, 'messages'> | null | undefined,
): { provider: string; model: string } | null {
  if (!thread) return null;
  const message = sessionLogThreadMetrics(thread as SessionLogThread)
    .context as SessionLogMessage | null;
  return message?.model ?? null;
}
