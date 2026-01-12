import { BILLING_ERROR_KEYWORDS, COMPLETION_MESSAGE_PATTERNS } from './constants';
import type { AgentStatus, BillingErrorContext } from './types';

export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function preprocessStreamData(rawData: string): string {
  let processedData = rawData;
  if (processedData.startsWith('data: ')) {
    processedData = processedData.substring(6).trim();
  }
  return processedData;
}

export function isCompletionMessage(processedData: string): boolean {
  const hasStatusType = processedData.includes(COMPLETION_MESSAGE_PATTERNS[0]);
  const hasCompleted = processedData.includes(COMPLETION_MESSAGE_PATTERNS[1]);
  
  return (
    (hasStatusType && hasCompleted) ||
    processedData.includes(COMPLETION_MESSAGE_PATTERNS[2]) ||
    processedData.includes(COMPLETION_MESSAGE_PATTERNS[3]) ||
    processedData === '{"type": "status", "status": "completed", "message": "Worker run completed successfully"}'
  );
}

export function isBillingError(message: string): boolean {
  const messageLower = message.toLowerCase();
  return BILLING_ERROR_KEYWORDS.some(keyword => messageLower.includes(keyword));
}

export function extractBillingErrorContext(errorMessage: string): BillingErrorContext {
  const messageLower = errorMessage.toLowerCase();
  const isCreditsExhausted = 
    messageLower.includes('insufficient credits') ||
    messageLower.includes('out of credits') ||
    messageLower.includes('no credits') ||
    messageLower.includes('balance');
  
  const balanceMatch = errorMessage.match(/balance is (-?\d+)\s*credits/i);
  const balance = balanceMatch ? balanceMatch[1] : null;
  
  return {
    errorMessage,
    balance,
    isCreditsExhausted,
  };
}

export function mapBackendStatus(backendStatus: string): AgentStatus {
  switch (backendStatus) {
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'connecting':
      return 'connecting';
    default:
      return 'error';
  }
}

export function isTerminalStatus(status: string): boolean {
  return ['completed', 'stopped', 'failed', 'error', 'agent_not_running'].includes(status);
}

export function calculateExponentialBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  multiplier: number = 2
): number {
  const delay = Math.min(baseDelay * Math.pow(multiplier, attempt), maxDelay);
  const jitter = Math.random() * 0.1 * delay;
  return delay + jitter;
}

export function createAbortController(): { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
}

export function formatStreamUrl(apiUrl: string, runId: string, token: string | null): string {
  const baseUrl = `${apiUrl}/agent-run/${runId}/stream`;
  return token ? `${baseUrl}?token=${token}` : baseUrl;
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let pendingCall: ReturnType<typeof setTimeout> | null = null;
  
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall >= limit) {
      lastCall = now;
      fn(...args);
    } else if (!pendingCall) {
      pendingCall = setTimeout(() => {
        lastCall = Date.now();
        fn(...args);
        pendingCall = null;
      }, limit - timeSinceLastCall);
    }
  };
}

export function rafThrottle<T extends (...args: unknown[]) => unknown>(
  fn: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  let latestArgs: Parameters<T> | null = null;
  
  return (...args: Parameters<T>) => {
    latestArgs = args;
    
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (latestArgs) {
          fn(...latestArgs);
        }
        rafId = null;
      });
    }
  };
}

export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
