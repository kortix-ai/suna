/**
 * Structured browser logger. Runtime observability is emitted by the Kortix
 * API/ACP proxy; the web client never calls a harness-specific logging route.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.error('Stream disconnected', { runId, attempt: 3 });
 */

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

}

export const logger = {
  debug: (message: string, extra?: LogExtra) => send('debug', message, extra),
  info: (message: string, extra?: LogExtra) => send('info', message, extra),
  warn: (message: string, extra?: LogExtra) => send('warn', message, extra),
  error: (message: string, extra?: LogExtra) => send('error', message, extra),
} as const;
