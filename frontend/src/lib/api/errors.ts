// Custom error classes for API operations

export class AgentRunLimitError extends Error {
  status: number;
  detail: { 
    message: string;
    running_thread_ids: string[];
    running_count: number;
  };

  constructor(
    status: number,
    detail: { 
      message: string;
      running_thread_ids: string[];
      running_count: number;
      [key: string]: any;
    },
    message?: string,
  ) {
    super(message || detail.message || `Agent Run Limit Exceeded: ${status}`);
    this.name = 'AgentRunLimitError';
    this.status = status;
    this.detail = detail;

    // Set the prototype explicitly.
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

export class NoAccessTokenAvailableError extends Error {
  constructor(message?: string, options?: { cause?: Error }) {
    super(message || 'No access token available', options);
  }
  name = 'NoAccessTokenAvailableError';
}

