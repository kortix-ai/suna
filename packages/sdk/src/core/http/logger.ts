/**
 * Structured logger for the SDK. Writes to the console only.
 *
 * It used to ALSO ship every entry to the sandbox's OpenCode server via
 * `getClient().app.log()` — a raw `POST /p/<box>/8000/log` per log line. This
 * logger is imported on the streaming HOT PATHS (`session-stream-controller`,
 * `use-session-stream`, `sandbox-connection-store`), so a degraded stream or a
 * retry ladder turned it into a flood: hundreds of raw `/log` POSTs while the
 * user watched a churning network tab (dev, 2026-08-27). It is also a RAW
 * OpenCode route the "web speaks only /kortix/*" cutover was meant to retire —
 * the web logger (`apps/web/src/lib/logger.ts`) was already fixed the same way;
 * this is its SDK-core twin. Console only. Daemon-side telemetry, if ever
 * wanted, goes through a BATCHED platform endpoint, never a per-line raw POST.
 *
 * Usage:
 *   import { logger } from '../http/logger';
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
