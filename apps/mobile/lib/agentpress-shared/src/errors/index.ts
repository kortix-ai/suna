export type TierErrorType =
  | 'THREAD_LIMIT_EXCEEDED'
  | 'AGENT_RUN_LIMIT_EXCEEDED'
  | 'PROJECT_LIMIT_EXCEEDED'
  | 'AGENT_LIMIT_EXCEEDED'
  | 'TRIGGER_LIMIT_EXCEEDED'
  | 'MODEL_ACCESS_DENIED'
  | 'CUSTOM_WORKER_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_CREDITS'
  | 'BILLING_ERROR';

export interface TierLimitErrorState {
  type: TierErrorType;
  message: string;
  currentCount?: number;
  limit?: number;
  tierName?: string;
  runningThreadIds?: string[];
  runningCount?: number;
}

export interface TierLimitErrorUI {
  alertTitle: string;
  alertSubtitle: string;
}

export function parseTierRestrictionError(error: any): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(error?.message || 'Unknown error');
}

export function isTierRestrictionError(error: any): boolean {
  const code = error?.code || error?.detail?.error_code;
  return !!code && [
    'THREAD_LIMIT_EXCEEDED', 'AGENT_RUN_LIMIT_EXCEEDED', 'PROJECT_LIMIT_EXCEEDED',
    'AGENT_LIMIT_EXCEEDED', 'TRIGGER_LIMIT_EXCEEDED', 'MODEL_ACCESS_DENIED',
    'CUSTOM_WORKER_LIMIT_EXCEEDED', 'INSUFFICIENT_CREDITS',
  ].includes(code);
}

export function extractTierLimitErrorState(error: any): TierLimitErrorState | null {
  if (!error) return null;
  const code = error?.code || error?.detail?.error_code;
  if (!code) return null;

  const detail = error?.detail || {};
  return {
    type: code as TierErrorType,
    message: detail.message || error.message || 'Limit exceeded',
    currentCount: detail.current_count,
    limit: detail.limit,
    tierName: detail.tier_name,
    runningThreadIds: detail.running_thread_ids,
    runningCount: detail.running_count,
  };
}

export function formatTierLimitErrorForUI(errorState: TierLimitErrorState): TierLimitErrorUI {
  switch (errorState.type) {
    case 'THREAD_LIMIT_EXCEEDED':
      return {
        alertTitle: 'Thread Limit Reached',
        alertSubtitle: errorState.message || 'Upgrade your plan to create more threads.',
      };
    case 'AGENT_RUN_LIMIT_EXCEEDED':
      return {
        alertTitle: 'Concurrent Run Limit',
        alertSubtitle: errorState.message || 'Too many agents running. Wait or upgrade.',
      };
    case 'INSUFFICIENT_CREDITS':
      return {
        alertTitle: 'Insufficient Credits',
        alertSubtitle: errorState.message || 'Purchase more credits or upgrade your plan.',
      };
    default:
      return {
        alertTitle: 'Limit Reached',
        alertSubtitle: errorState.message || 'Upgrade your plan for more capacity.',
      };
  }
}

export function formatTierErrorForUI(error: any): TierLimitErrorUI | null {
  const state = extractTierLimitErrorState(error);
  if (!state) return null;
  return formatTierLimitErrorForUI(state);
}
