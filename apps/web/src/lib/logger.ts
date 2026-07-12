/**
 * Structured logger that ships log entries to the OpenCode server
 * via `client.app.log()` while also writing to the browser console
 * for local development visibility.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.error('Stream disconnected', { runId, attempt: 3 });
 */

import { getClient } from '@/lib/opencode-sdk';

const SERVICE_NAME = 'frontend';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogExtra {
  [key: string]: unknown;
}

function send(level: LogLevel, message: string, extra?: LogExtra): void {
  // Always mirror to the browser console so dev-tools still work.
  const consoleFn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.log;

  consoleFn(`[${SERVICE_NAME}] ${message}`, ...(extra ? [extra] : []));

  // Fire-and-forget: ship the log entry to the server.
  // Wrapped in try/catch so a logging failure never breaks the caller.
  try {
    const client = getClient();
    client.app.log({
      service: SERVICE_NAME,
      level,
      message,
      extra,
    });
  } catch {
    // Swallow — if the SDK client isn't available yet (e.g. during SSR or
    // before the first server URL is resolved) we just skip server logging.
  }
}

export const logger = {
  debug: (message: string, extra?: LogExtra) => send('debug', message, extra),
  info: (message: string, extra?: LogExtra) => send('info', message, extra),
  warn: (message: string, extra?: LogExtra) => send('warn', message, extra),
  error: (message: string, extra?: LogExtra) => send('error', message, extra),
} as const;
