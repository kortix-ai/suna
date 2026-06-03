import { toast } from '@/lib/toast';
import { BillingError, formatBillingErrorForUI } from './api/errors';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { isBillingEnabled } from '@/lib/config';
import * as Sentry from '@sentry/nextjs';

export interface ApiError extends Error {
  status?: number;
  code?: string;
  details?: any;
  response?: Response;
}

export interface ErrorContext {
  operation?: string;
  resource?: string;
  silent?: boolean;
}

const getStatusMessage = (status: number): string => {
  switch (status) {
    case 400:
      return 'Invalid request. Please check your input and try again.';
    case 401:
      return 'Authentication required. Please sign in again.';
    case 403:
      return 'Access denied. You don\'t have permission to perform this action.';
    case 404:
      return 'The requested resource was not found.';
    case 408:
      return 'Request timeout. Please try again.';
    case 409:
      return 'Conflict detected. The resource may have been modified by another user.';
    case 422:
      return 'Invalid data provided. Please check your input.';
    case 429:
      return 'Too many requests. Please wait a moment and try again.';
    case 500:
      return 'Server error. Our team has been notified.';
    case 502:
      return 'Service temporarily unavailable. Please try again in a moment.';
    case 503:
      return 'Service maintenance in progress. Please try again later.';
    case 504:
      return 'Request timeout. The server took too long to respond.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
};

const extractErrorMessage = (error: any): string => {
  if (error instanceof BillingError) {
    return error.detail?.message || error.message || 'Billing issue detected';
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error?.response) {
    const status = error.response.status;
    return getStatusMessage(status);
  }

  if (error?.status) {
    return getStatusMessage(error.status);
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error?.message) {
    return error.message;
  }

  if (error?.error) {
    return typeof error.error === 'string' ? error.error : error.error.message || 'Unknown error';
  }

  return 'An unexpected error occurred';
};

const shouldShowError = (error: any, context?: ErrorContext): boolean => {
  if (context?.silent) {
    return false;
  }
  if (error instanceof BillingError) {
    return false;
  }

  if (error?.status === 404 && context?.resource) {
    return false;
  }

  return true;
};

// Suppress duplicate toasts when the same error fires repeatedly — typically
// a polling query (sessions list, project metadata) hitting a 403/5xx every
// few seconds. We keep one toast per (status, message) per dedupe window;
// after the window passes, a fresh toast can fire as a reminder.
const TOAST_DEDUPE_MS = 30_000;
const recentToasts = new Map<string, number>();

const shouldSuppressDuplicate = (status: number | undefined, message: string): boolean => {
  const key = `${status ?? 'x'}:${message}`;
  const now = Date.now();
  const lastShown = recentToasts.get(key);
  if (lastShown && now - lastShown < TOAST_DEDUPE_MS) {
    return true;
  }
  recentToasts.set(key, now);
  // Opportunistically prune so the map doesn't grow unbounded across a session.
  if (recentToasts.size > 50) {
    for (const [k, t] of recentToasts) {
      if (now - t >= TOAST_DEDUPE_MS) recentToasts.delete(k);
    }
  }
  return false;
};

const formatErrorMessage = (message: string, context?: ErrorContext): string => {
  if (!context?.operation && !context?.resource) {
    return message;
  }

  const parts = [];
  
  if (context.operation) {
    parts.push(`Failed to ${context.operation}`);
  }
  
  if (context.resource) {
    parts.push(context.resource);
  }

  const prefix = parts.join(' ');
  
  if (message.toLowerCase().includes(context.operation?.toLowerCase() || '')) {
    return message;
  }

  return `${prefix}: ${message}`;
};


export const handleApiError = (error: any, context?: ErrorContext): void => {
  const status = error?.status || error?.response?.status;
  // Expected 4xx (auth, validation, forbidden, not-found, etc.) should not
  // light up the Next.js dev overlay — they're user-facing business outcomes
  // we already surface via toast. Keep server errors and network failures
  // at console.error so real bugs still surface.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    console.warn('API Error:', error, context);
  } else {
    console.error('API Error:', error, context);
  }

  // Report server errors (5xx) and network failures to Better Stack via Sentry.
  // 4xx errors are expected (auth, validation) and don't need alerting.
  if (status >= 500 || error?.code === 'TIMEOUT' || error?.code === 'NETWORK_ERROR') {
    Sentry.captureException(error instanceof Error ? error : new Error(error?.message || String(error)), {
      tags: {
        errorType: status >= 500 ? 'server_error' : 'network_error',
        statusCode: status?.toString(),
        operation: context?.operation,
      },
      extra: {
        context,
        status,
        code: error?.code,
      },
    });
  }

  // Billing v2 — structured 402 detection runs BEFORE shouldShowError, because
  // shouldShowError short-circuits on `error instanceof BillingError` to
  // suppress its toast — but we still need to open the upgrade dialog for
  // those errors. Don't rely on `instanceof` here either, since Next.js HMR
  // can swap the class identity across module reloads.
  const v2Status: number | undefined =
    (error as any)?.status ?? (error as any)?.response?.status;
  const errAny = error as any;
  const v2Detail =
    errAny?.detail ??
    errAny?.data ??
    errAny?.details ??
    (typeof errAny === 'object' ? errAny : null);
  const v2Code: string | undefined =
    v2Detail?.code ??
    errAny?.code;
  const v2Message: string | undefined =
    v2Detail?.message ??
    v2Detail?.error ??
    errAny?.message;
  const v2Balance: number =
    typeof v2Detail?.balance === 'number' ? v2Detail.balance : 0;

  // No active plan → pitch the one central Team plan subscribe modal.
  if (
    isBillingEnabled() &&
    v2Status === 402 &&
    (v2Code === 'subscription_required' || v2Code === 'no_account')
  ) {
    useUpgradeDialogStore.getState().openUpgradeDialog({
      reason: v2Code,
      message: v2Message ?? '',
      balance: v2Balance,
    });
    return;
  }

  // Already on a plan but the wallet ran dry. Don't pitch a subscription —
  // they're subscribed and can still CRUD sessions; only metered LLM/compute
  // spend is affected. Nudge a top-up instead of blocking with the modal.
  if (isBillingEnabled() && v2Status === 402 && v2Code === 'insufficient_credits') {
    const title = 'Out of credits';
    if (!shouldSuppressDuplicate(v2Status, title)) {
      toast.warning(title, {
        description: 'Top up your wallet or turn on auto-refill to keep using compute and LLMs.',
        duration: 6000,
        action: {
          label: 'Top up',
          onClick: () =>
            useAccountSettingsModalStore
              .getState()
              .openAccountSettings({ tab: 'billing', highlight: 'credits' }),
        },
      });
    }
    return;
  }

  // Concurrent session limit — single clean toast with usage + an Open Settings
  // action. The dedup key (status, message) suppresses any duplicate the call
  // site might also emit with the same body.
  if (v2Status === 429 && v2Code === 'concurrent_session_limit') {
    const limit = typeof v2Detail?.limit === 'number' ? v2Detail.limit : undefined;
    const active = typeof v2Detail?.active_sessions === 'number' ? v2Detail.active_sessions : undefined;
    const title = limit !== undefined
      ? `You're at your session limit (${active ?? limit}/${limit})`
      : 'Session limit reached';
    if (!shouldSuppressDuplicate(v2Status, title)) {
      toast.warning(title, {
        description: 'Close a running session, or upgrade your plan for more.',
        duration: 6000,
        action: {
          label: 'Manage plan',
          onClick: () =>
            useAccountSettingsModalStore.getState().openAccountSettings({ tab: 'billing' }),
        },
      });
    }
    return;
  }

  if (!shouldShowError(error, context)) {
    return;
  }

  const rawMessage = extractErrorMessage(error);
  const formattedMessage = formatErrorMessage(rawMessage, context);

  // Legacy 402 paths (no structured code) — preserved behaviour.
  const errorUI = formatBillingErrorForUI(error);
  if (errorUI) {
    const detail = (error as BillingError)?.detail as
      | { code?: string; message?: string; balance?: number }
      | undefined;

    const message = detail?.message?.toLowerCase() || '';
    const isCreditsExhausted =
      message.includes('credit') ||
      message.includes('balance') ||
      message.includes('insufficient');

    if (isCreditsExhausted) {
      useAccountSettingsModalStore.getState().openAccountSettings({
        tab: 'billing',
        highlight: 'credits',
      });
      toast.error(errorUI.alertTitle, {
        description: errorUI.alertSubtitle,
        duration: 6000,
      });
    } else {
      useNewInstanceModalStore.getState().openNewInstanceModal(errorUI.alertTitle);
    }
    return;
  }

  if (shouldSuppressDuplicate(status, formattedMessage)) {
    return;
  }

  if (error?.status >= 500) {
    toast.error(formattedMessage, {
      description: 'Our team has been notified and is working on a fix.',
      duration: 6000,
    });
  } else if (error?.status === 403) {
    toast.error(formattedMessage, {
      description: 'Contact support if you believe this is an error.',
      duration: 6000,
    });
  } else if (error?.status === 429) {
    toast.warning(formattedMessage, {
      description: 'Please wait a moment before trying again.',
      duration: 5000,
    });
  } else {
    toast.error(formattedMessage, {
      duration: 5000,
    });
  }
};

export const handleNetworkError = (error: any, context?: ErrorContext): void => {
  const isNetworkError = 
    error?.message?.includes('fetch') ||
    error?.message?.includes('network') ||
    error?.message?.includes('connection') ||
    error?.code === 'NETWORK_ERROR' ||
    !navigator.onLine;

  if (isNetworkError) {
    // Report network errors to Sentry — these indicate connectivity issues
    Sentry.captureException(
      error instanceof Error ? error : new Error(error?.message || 'Network error'),
      {
        tags: { errorType: 'network_error', operation: context?.operation },
        level: 'warning',
      },
    );
    toast.error('Connection error', {
      description: 'Please check your internet connection and try again.',
      duration: 6000,
    });
  } else {
    handleApiError(error, context);
  }
};
