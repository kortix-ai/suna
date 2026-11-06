/**
 * Structured logger with queryable format for easy filtering and parsing
 * 
 * Format: [KTX] [USER:abc123] [LEVEL:info] [COMPONENT:RC] message
 * 
 * Usage:
 *   import { log, setLoggerUserId } from '@/lib/logger';
 *   log.info('Something happened');
 *   // Output: [KTX] [USER:abc12345] [LEVEL:info] Something happened
 * 
 *   log.rc('SDK initialized');
 *   // Output: [KTX] [USER:abc12345] [LEVEL:info] [COMPONENT:RC] SDK initialized
 * 
 *   log.error('Failed!', error);
 *   // Output: [KTX] [USER:abc12345] [LEVEL:error] Failed! <error>
 * 
 * Set user ID (call from auth context):
 *   setLoggerUserId(userId);               // Set current user ID
 *   setLoggerUserId(null);                 // Clear user ID (on logout)
 * 
 * Query examples:
 *   # Filter by user
 *   idevicesyslog | grep "\[USER:abc12345\]"
 * 
 *   # Filter by level
 *   idevicesyslog | grep "\[LEVEL:error\]"
 * 
 *   # Filter by component
 *   idevicesyslog | grep "\[COMPONENT:RC\]"
 * 
 *   # Filter by user AND level
 *   idevicesyslog | grep "\[USER:abc12345\]" | grep "\[LEVEL:error\]"
 * 
 *   # Extract all errors for a user (using awk)
 *   idevicesyslog | grep "\[USER:abc12345\]" | grep "\[LEVEL:error\]" | awk -F'\[LEVEL:error\]' '{print $2}'
 * 
 *   # Count errors per user
 *   idevicesyslog | grep "\[LEVEL:error\]" | grep -o "\[USER:[^]]*\]" | sort | uniq -c
 */

// Global variable to store current user ID
let currentUserId: string | null = null;

/**
 * Set the current user ID for logging
 * Call this from AuthContext when user logs in/out
 */
export function setLoggerUserId(userId: string | null): void {
  currentUserId = userId;
}

/**
 * Format user ID for log prefix
 */
function formatUserId(): string {
  const userId = currentUserId || 'anonymous';
  // Truncate long user IDs for readability (show first 12 chars)
  const shortId = userId.length > 12 ? userId.substring(0, 12) : userId;
  return `[USER:${shortId}]`;
}

/**
 * Build structured log prefix
 */
function buildPrefix(level: string, component?: string): string {
  const parts = [
    '[KTX]',
    formatUserId(),
    `[LEVEL:${level}]`,
  ];
  
  if (component) {
    parts.push(`[COMPONENT:${component}]`);
  }
  
  return parts.join(' ');
}

/**
 * Per-argument character cap. Release builds keep less: logcat and os_log are
 * readable over adb and in bug reports.
 */
export const DEV_ARG_MAX_CHARS = 2_000;
export const RELEASE_ARG_MAX_CHARS = 500;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Format log arguments for structured output. Errors become `name: message`
 * (JSON.stringify turns an Error into `{}`), objects are serialised, and every
 * string result is capped at `maxChars`. Cyclic objects fall back to `String()`.
 */
export function formatArgs(args: unknown[], maxChars: number): unknown[] {
  return args.map((arg) => {
    if (arg instanceof Error) return truncate(`${arg.name}: ${arg.message}`, maxChars);
    if (typeof arg === 'string') return truncate(arg, maxChars);
    if (typeof arg === 'object' && arg !== null) {
      let text: string;
      try {
        text = JSON.stringify(arg, null, 0) ?? String(arg);
      } catch {
        text = String(arg);
      }
      return truncate(text, maxChars);
    }
    return arg;
  });
}

function format(args: unknown[]): unknown[] {
  return formatArgs(args, __DEV__ ? DEV_ARG_MAX_CHARS : RELEASE_ARG_MAX_CHARS);
}

type Sink = 'log' | 'info' | 'debug' | 'warn' | 'error';

/**
 * One `log` entry: `console[sink]` behind the structured prefix. Only the
 * error sink still writes in release builds; every other entry returns early.
 */
function make(sink: Sink, level: string, component?: string) {
  return (...args: unknown[]) => {
    if (sink !== 'error' && !__DEV__) return;
    console[sink](buildPrefix(level, component), ...format(args));
  };
}

export const log = {
  /** Standard log (level: info) */
  log: make('log', 'info'),
  /** Info level */
  info: make('info', 'info'),
  /** Debug level */
  debug: make('debug', 'debug'),
  /** Warning level */
  warn: make('warn', 'warn'),
  /** Error level */
  error: make('error', 'error'),
  /** RevenueCat-specific logs (level: info) */
  rc: make('log', 'info', 'RC'),
  /** RevenueCat debug */
  rcDebug: make('debug', 'debug', 'RC'),
  /** RevenueCat warning */
  rcWarn: make('warn', 'warn', 'RC'),
  /** RevenueCat error */
  rcError: make('error', 'error', 'RC'),
};

export default log;

