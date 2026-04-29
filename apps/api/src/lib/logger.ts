/**
 * Structured logger for Kortix API.
 *
 * Uses @logtail/node to ship structured logs to Better Stack Telemetry.
 * Automatically enriches every log with request context (userId, accountId,
 * sandboxId, requestId) via AsyncLocalStorage — zero manual passing needed.
 *
 * Also patches console.error/warn globally so ALL existing calls across
 * the codebase ship to Better Stack with request context attached.
 *
 * Usage:
 *   import { logger } from './lib/logger';
 *   logger.info('User logged in', { method: 'oauth' });
 *   // → automatically includes userId, accountId, requestId, path, etc.
 */

import { Logtail } from '@logtail/node';
import { getContextFields } from './request-context';

// ─── Configuration ──────────────────────────────────────────────────────────

const LOG_TOKEN = process.env.BETTERSTACK_API_LOG_TOKEN;
const LOG_HOST = process.env.BETTERSTACK_API_LOG_HOST;
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as LogLevel;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Better Stack Client ────────────────────────────────────────────────────

let logtail: Logtail | null = null;

if (LOG_TOKEN) {
  logtail = new Logtail(LOG_TOKEN, {
    ...(LOG_HOST ? { endpoint: `https://${LOG_HOST}` } : {}),
  });
}

// ─── Static enrichment (same for every log) ─────────────────────────────────

const BASE_CONTEXT = {
  service: 'kortix-api',
  env: process.env.INTERNAL_KORTIX_ENV || 'dev',
  version: process.env.SANDBOX_VERSION || 'dev',
};

// ─── Ship to Better Stack ───────────────────────────────────────────────────

function shipToBetterStack(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!logtail) return;

  // Merge: base static context + async request context + explicit context
  const requestCtx = getContextFields();
  const enriched = { ...BASE_CONTEXT, ...requestCtx, ...context };

  switch (level) {
    case 'debug': logtail.debug(message, enriched); break;
    case 'info':  logtail.info(message, enriched);  break;
    case 'warn':  logtail.warn(message, enriched);  break;
    case 'error': logtail.error(message, enriched); break;
  }
}

// ─── Logger Implementation ──────────────────────────────────────────────────

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LOG_LEVEL];
}

function formatForConsole(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const ctx = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${ctx}`;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  // Write to stdout/stderr (Docker captures these)
  const formatted = formatForConsole(level, message, context);
  if (level === 'error') {
    originalConsoleError(formatted);
  } else if (level === 'warn') {
    originalConsoleWarn(formatted);
  } else {
    console.log(formatted);
  }

  // Ship to Better Stack (request context auto-attached)
  shipToBetterStack(level, message, context);
}

// ─── Global console.error/warn patch ────────────────────────────────────────
//
// Intercepts ALL console.error() and console.warn() calls across the entire
// codebase and ships them to Better Stack with request context automatically
// attached. This captures the 290+ existing console.error/warn calls in
// catch blocks, provider code, startup logic, etc.

const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleLog = console.log.bind(console);

if (logtail) {
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const message = args.map(a =>
      a instanceof Error ? `${a.message}\n${a.stack}` :
      typeof a === 'string' ? a :
      JSON.stringify(a)
    ).join(' ');
    // Request context (userId, accountId, sandboxId, requestId) auto-attached
    shipToBetterStack('error', message);
  };

  console.warn = (...args: unknown[]) => {
    originalConsoleWarn(...args);
    const message = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    shipToBetterStack('warn', message);
  };

  // Patch console.log so all existing info-level calls across the codebase
  // (billing/webhooks, pool/, tunnel/, etc.) ship to Better Stack with
  // request context attached — no call-site changes required.
  console.log = (...args: unknown[]) => {
    originalConsoleLog(...args);
    const message = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    shipToBetterStack('info', message);
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => log('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => log('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => log('error', message, context),

  /**
   * Flush all pending logs to Better Stack.
   * Call this before process exit to ensure no logs are lost.
   */
  flush: async (): Promise<void> => {
    if (logtail) {
      await logtail.flush();
    }
  },
};
