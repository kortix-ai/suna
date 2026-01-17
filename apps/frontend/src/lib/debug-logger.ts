/**
 * Debug logger that sends logs to terminal via API endpoint
 * Only active in development mode
 */

const DEBUG_ENABLED = process.env.NODE_ENV === 'development';
const DEBUG_ENDPOINT = '/api/debug-log';

type LogData = Record<string, unknown>;

// Debounce/batch logs to reduce API calls
let logQueue: Array<{ tag: string; data: LogData; timestamp: number }> = [];
let flushTimeout: NodeJS.Timeout | null = null;

function flushLogs() {
  if (logQueue.length === 0) return;

  const logsToSend = [...logQueue];
  logQueue = [];

  // Fire and forget - don't await
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: logsToSend }),
  }).catch(() => {
    // Silently fail - debug logging shouldn't break the app
  });
}

export function debugLog(tag: string, data: LogData = {}) {
  if (!DEBUG_ENABLED) return;

  logQueue.push({
    tag,
    data,
    timestamp: Date.now(),
  });

  // Flush after 50ms of no new logs (batch nearby logs together)
  if (flushTimeout) {
    clearTimeout(flushTimeout);
  }
  flushTimeout = setTimeout(flushLogs, 50);
}

// Convenience function for immediate flush (useful before navigation)
export function flushDebugLogs() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  flushLogs();
}
