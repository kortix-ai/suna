import { HTTPException } from 'hono/http-exception';

// ─── Billing Errors ─────────────────────────────────────────────────────────

export class BillingError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'BillingError';
    this.statusCode = statusCode;
  }
}

export class InsufficientCreditsError extends BillingError {
  constructor(
    public readonly balance: number,
    public readonly required: number,
  ) {
    super(`Insufficient credits. Balance: $${balance.toFixed(4)}, required: $${required.toFixed(4)}`, 402);
    this.name = 'InsufficientCreditsError';
  }
}

export class SubscriptionError extends BillingError {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export class WebhookError extends BillingError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'WebhookError';
  }
}

// ─── HTTP Errors ────────────────────────────────────────────────────────────

export class NotFoundError extends HTTPException {
  constructor(resource: string, id: string) {
    super(404, { message: `${resource} not found: ${id}` });
  }
}

export class ConflictError extends HTTPException {
  constructor(message: string) {
    super(409, { message });
  }
}

export class ValidationError extends HTTPException {
  constructor(message: string) {
    super(400, { message });
  }
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly triggerId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

// ─── Channel Errors ──────────────────────────────────────────────────────────

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

export class WebhookVerificationError extends HTTPException {
  constructor(message: string = 'Webhook verification failed') {
    super(401, { message });
  }
}
