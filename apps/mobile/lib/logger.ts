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
 * Format log arguments for structured output
 */
function formatArgs(args: unknown[]): unknown[] {
  // If first arg is a string, keep it as is
  // Otherwise, format objects nicely
  return args.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, null, 0);
      } catch {
        return String(arg);
      }
    }
    return arg;
  });
}

export const log = {
  /** Standard log (level: info) */
  log: (...args: unknown[]) => {
    console.log(buildPrefix('info'), ...formatArgs(args));
  },
  
  /** Info level */
  info: (...args: unknown[]) => {
    console.info(buildPrefix('info'), ...formatArgs(args));
  },
  
  /** Debug level */
  debug: (...args: unknown[]) => {
    console.debug(buildPrefix('debug'), ...formatArgs(args));
  },
  
  /** Warning level */
  warn: (...args: unknown[]) => {
    console.warn(buildPrefix('warn'), ...formatArgs(args));
  },
  
  /** Error level */
  error: (...args: unknown[]) => {
    console.error(buildPrefix('error'), ...formatArgs(args));
  },
  
  /** RevenueCat-specific logs (level: info) */
  rc: (...args: unknown[]) => {
    console.log(buildPrefix('info', 'RC'), ...formatArgs(args));
  },
  
  /** RevenueCat debug */
  rcDebug: (...args: unknown[]) => {
    console.debug(buildPrefix('debug', 'RC'), ...formatArgs(args));
  },
  
  /** RevenueCat warning */
  rcWarn: (...args: unknown[]) => {
    console.warn(buildPrefix('warn', 'RC'), ...formatArgs(args));
  },
  
  /** RevenueCat error */
  rcError: (...args: unknown[]) => {
    console.error(buildPrefix('error', 'RC'), ...formatArgs(args));
  },
};

export default log;

