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
 * Get the current user ID (for testing/debugging)
 */
export function getLoggerUserId(): string | null {
  return currentUserId;
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

export const log = {
  /** Standard log (level: info) */
  log: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.log(buildPrefix('info'), ...format(args));
  },

  /** Info level */
  info: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.info(buildPrefix('info'), ...format(args));
  },

  /** Debug level */
  debug: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.debug(buildPrefix('debug'), ...format(args));
  },

  /** Warning level */
  warn: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.warn(buildPrefix('warn'), ...format(args));
  },

  /** Error level */
  error: (...args: unknown[]) => {
    console.error(buildPrefix('error'), ...format(args));
  },

  /** RevenueCat-specific logs (level: info) */
  rc: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.log(buildPrefix('info', 'RC'), ...format(args));
  },

  /** RevenueCat debug */
  rcDebug: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.debug(buildPrefix('debug', 'RC'), ...format(args));
  },

  /** RevenueCat warning */
  rcWarn: (...args: unknown[]) => {
    if (!__DEV__) return;
    console.warn(buildPrefix('warn', 'RC'), ...format(args));
  },

  /** RevenueCat error */
  rcError: (...args: unknown[]) => {
    console.error(buildPrefix('error', 'RC'), ...format(args));
  },
};

export default log;

