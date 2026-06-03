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

export class WebhookError extends BillingError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'WebhookError';
  }
}
