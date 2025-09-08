import { toast } from 'sonner';
import { BillingError, AgentRunLimitError, ProjectLimitError } from './api';

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

  if (error instanceof AgentRunLimitError) {
    return error.detail?.message || error.message || 'Agent run limit exceeded';
  }

  if (error instanceof ProjectLimitError) {
    return error.detail?.message || error.message || 'Project limit exceeded';
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
  if (error instanceof AgentRunLimitError) {
    return false;
  }

  if (error?.status === 404 && context?.resource) {
    return false;
  }

  return true;
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
  console.error('API Error:', error, context);

  if (!shouldShowError(error, context)) {
    return;
  }

  const rawMessage = extractErrorMessage(error);
  const formattedMessage = formatErrorMessage(rawMessage, context);

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
    toast.error('Connection error', {
      description: 'Please check your internet connection and try again.',
      duration: 6000,
    });
  } else {
    handleApiError(error, context);
  }
};

export const handleApiSuccess = (message: string, description?: string): void => {
  toast.success(message, {
    description,
    duration: 3000,
  });
};

export const handleApiWarning = (message: string, description?: string): void => {
  toast.warning(message, {
    description,
    duration: 4000,
  });
};

export const handleApiInfo = (message: string, description?: string): void => {
  toast.info(message, {
    description,
    duration: 3000,
  });
}; 