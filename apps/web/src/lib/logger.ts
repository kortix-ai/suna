/**
 * Structured logger for the web app. Writes to the browser console only.
 *
 * It used to ALSO ship every entry to the sandbox's OpenCode server via
 * `logRuntimeEvent` → `getClient().app.log()` — a raw `POST /p/<box>/8000/log`
 * per log line. Two problems, both real (dev, 2026-08-27): it is a RAW OpenCode
 * route the "web speaks only /kortix/*" cutover was meant to retire, and it
 * FLOODS — one network POST per frontend log, hundreds of them once anything
 * logs in a loop (a degraded stream, a retry ladder). Frontend logs belong in
 * the browser console where the developer already is, not fanned out to the
 * session sandbox one request at a time. If daemon-side frontend telemetry is
 * ever wanted, it goes through a BATCHED platform endpoint, never a per-line
 * raw runtime POST.
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
