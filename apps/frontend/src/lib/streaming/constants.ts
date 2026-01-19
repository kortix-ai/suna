export const STREAM_CONFIG = {
  HEARTBEAT_TIMEOUT_MS: 30000,
  HEARTBEAT_CHECK_INTERVAL_MS: 10000,
  
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 30000,
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_BACKOFF_MULTIPLIER: 2,
  
  STATUS_CHECK_DELAY_MS: 500,
  
  TOOL_CALL_THROTTLE_MS: 16,
  
  CONTENT_FLUSH_INTERVAL_MS: 16,
  
  STREAM_POLL_BLOCK_MS: 500,
} as const;

export const TERMINAL_STATUSES = [
  'completed',
  'stopped',
  'failed',
  'error',
  'agent_not_running',
] as const;

export const BILLING_ERROR_KEYWORDS = [
  'insufficient credits',
  'out of credits',
  'no credits',
  'balance',
  'credit',
  'billing check failed',
] as const;

export const COMPLETION_MESSAGE_PATTERNS = [
  '"type": "status"',
  '"status": "completed"',
  'Run data not available for streaming',
  'Stream ended with status: completed',
] as const;

export const API_ENDPOINTS = {
  STREAM: (runId: string) => `/agent-run/${runId}/stream`,
  STOP: (runId: string) => `/agent-runs/${runId}/stop`,
  STATUS: (runId: string) => `/agent-runs/${runId}/status`,
} as const;

export type TerminalStatus = typeof TERMINAL_STATUSES[number];
