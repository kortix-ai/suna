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
    /** Why the wallet refused, e.g. `Insufficient credits` or `No credit account found`. */
    public readonly reason: string = 'Insufficient credits',
  ) {
    super(`Insufficient credits. Balance: $${balance.toFixed(4)}, required: $${required.toFixed(4)}`, 402);
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * The wallet could not answer: pool exhausted, statement timeout, deadlock,
 * lost connection. NOT a refusal. The account may have funds. Retryable.
 */
export class WalletUnavailableError extends BillingError {
  constructor(message = 'Billing is temporarily unavailable. Retry shortly.') {
    super(message, 503);
    this.name = 'WalletUnavailableError';
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
