export class AgentRunLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    running_thread_ids: string[];
    running_count: number;
    limit: number;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      running_thread_ids: string[];
      running_count: number;
      limit: number;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Agent Run Limit Exceeded: ${status}`);
    this.name = 'AgentRunLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, AgentRunLimitError.prototype);
  }
}

export class AgentCountLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Agent Count Limit Exceeded: ${status}`);
    this.name = 'AgentCountLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, AgentCountLimitError.prototype);
  }
}

export class ProjectLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Project Limit Exceeded: ${status}`);
    this.name = 'ProjectLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ProjectLimitError.prototype);
  }
}

export class BillingError extends Error {
  status: number;
  detail: { message: string; [key: string]: any }; // Allow other properties in detail

  constructor(
    status: number,
    detail: { message: string; [key: string]: any },
    message?: string,
  ) {
    super(message || detail.message || `Billing Error: ${status}`);
    this.name = 'BillingError';
    this.status = status;
    this.detail = detail;

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

export class TriggerLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    trigger_type: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      trigger_type: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Trigger Limit Exceeded: ${status}`);
    this.name = 'TriggerLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, TriggerLimitError.prototype);
  }
}

export class ModelAccessDeniedError extends Error {
  status: number;
  detail: { 
    message: string;
    tier_name?: string;
    error_code?: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      tier_name?: string;
      error_code?: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Model Access Denied: ${status}`);
    this.name = 'ModelAccessDeniedError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ModelAccessDeniedError.prototype);
  }
}

export class CustomWorkerLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Custom Worker Limit Exceeded: ${status}`);
    this.name = 'CustomWorkerLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, CustomWorkerLimitError.prototype);
  }
}

export class ThreadLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    current_count: number;
    limit: number;
    tier_name: string;
    error_code: string;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      current_count: number;
      limit: number;
      tier_name: string;
      error_code: string;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Thread Limit Exceeded: ${status}`);
    this.name = 'ThreadLimitError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ThreadLimitError.prototype);
  }
}

export class NoAccessTokenAvailableError extends Error {
  constructor(message?: string, options?: { cause?: Error }) {
    super(message || 'No access token available', options);
  }
  name = 'NoAccessTokenAvailableError';
}

/**
 * Error thrown when HTTP request headers are too large (HTTP 431).
 * This typically happens when:
 * - Uploading many files at once in a single request
 * - JWT tokens are very large
 * - Too many cookies are being sent
 */
export class RequestTooLargeError extends Error {
  status: number;
  detail: {
    message: string;
    suggestion: string;
  };

  constructor(
    status: number = 431,
    detail?: { message?: string; suggestion?: string },
    message?: string,
  ) {
    const defaultMessage = 'Request headers are too large';
    const defaultSuggestion = 'Try uploading files one at a time, or reduce the number of files in a single request.';
    
    super(message || detail?.message || defaultMessage);
    this.name = 'RequestTooLargeError';
    this.status = status;
    this.detail = {
      message: detail?.message || defaultMessage,
      suggestion: detail?.suggestion || defaultSuggestion,
    };
    Object.setPrototypeOf(this, RequestTooLargeError.prototype);
  }
}

export function parseTierRestrictionError(error: any): Error {
  const status = error.response?.status || error.status;
  const errorData = error.response?.data || error.data || error.detail || {};
  const errorCode = errorData?.detail?.error_code || errorData?.error_code;

  if (status !== 402 || !errorCode) {
    return error;
  }

  const detail = errorData?.detail || errorData;

  switch (errorCode) {
    case 'AGENT_RUN_LIMIT_EXCEEDED':
      return new AgentRunLimitError(status, detail);
    
    case 'PROJECT_LIMIT_EXCEEDED':
      return new ProjectLimitError(status, detail);
    
    case 'AGENT_LIMIT_EXCEEDED':
      return new AgentCountLimitError(status, detail);
    
    case 'TRIGGER_LIMIT_EXCEEDED':
      return new TriggerLimitError(status, detail);
    
    case 'MODEL_ACCESS_DENIED':
      return new ModelAccessDeniedError(status, detail);
    
    case 'CUSTOM_WORKER_LIMIT_EXCEEDED':
      return new CustomWorkerLimitError(status, detail);
    
    case 'THREAD_LIMIT_EXCEEDED':
      return new ThreadLimitError(status, detail);
    
    case 'INSUFFICIENT_CREDITS':
      return new BillingError(status, detail);
    
    default:
      // For 402 errors without a specific code, treat as billing error
      if (status === 402) {
        return new BillingError(status, detail);
      }
      return error;
  }
}
