/**
 * Which saved payment method can auto-topup charge off-session?
 *
 * This used to look in exactly two places, both card-shaped:
 *   1. `customer.invoice_settings.default_payment_method`
 *   2. `paymentMethods.list({ type: 'card' })`
 *
 * Neither is populated for a customer who checked out with Stripe Link (or
 * SEPA, or any other non-card method): Checkout attaches the payment method to
 * the SUBSCRIPTION as its `default_payment_method` and never writes the
 * customer-level invoice default, and a `type: 'card'` list filter excludes a
 * `link` payment method outright. The result was a customer paying a real $40
 * monthly invoice from a real payment method being told "No default payment
 * method found", with auto-topup silently refusing to fire — forever, and
 * without incrementing any failure counter, so it was invisible in the data.
 *
 * The resolver is pure so every combination is unit-testable without Stripe.
 */

export type PaymentMethodSource = 'customer_default' | 'subscription_default' | 'attached';

export interface PaymentMethodResolutionInput {
  /** `customer.invoice_settings.default_payment_method`, if set. */
  customerDefaultPaymentMethodId?: string | null;
  /** The active subscription's `default_payment_method` — where Checkout puts
   *  a Link/SEPA/card method when it doesn't touch the customer default. */
  subscriptionDefaultPaymentMethodId?: string | null;
  /** Every payment method attached to the customer, ANY type. Never filter this
   *  to `card` — that is what hid Link methods. */
  attachedPaymentMethodIds?: readonly string[];
}

export interface PaymentMethodResolution {
  /** A charge can be attempted. */
  hasAnyPaymentMethod: boolean;
  /** A method is designated as the default (customer-level or subscription-level).
   *  NOT a precondition for charging — `hasAnyPaymentMethod` is. */
  hasDefaultPaymentMethod: boolean;
  usablePaymentMethodId: string | null;
  source: PaymentMethodSource | null;
}

function firstNonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveUsablePaymentMethod(
  input: PaymentMethodResolutionInput,
): PaymentMethodResolution {
  const customerDefault = firstNonEmpty(input.customerDefaultPaymentMethodId);
  const subscriptionDefault = firstNonEmpty(input.subscriptionDefaultPaymentMethodId);
  const attached = (input.attachedPaymentMethodIds ?? [])
    .map(firstNonEmpty)
    .filter((id): id is string => id !== null);

  const hasDefaultPaymentMethod = customerDefault !== null || subscriptionDefault !== null;

  if (customerDefault) {
    return {
      hasAnyPaymentMethod: true,
      hasDefaultPaymentMethod,
      usablePaymentMethodId: customerDefault,
      source: 'customer_default',
    };
  }
  if (subscriptionDefault) {
    return {
      hasAnyPaymentMethod: true,
      hasDefaultPaymentMethod,
      usablePaymentMethodId: subscriptionDefault,
      source: 'subscription_default',
    };
  }
  if (attached[0]) {
    return {
      hasAnyPaymentMethod: true,
      hasDefaultPaymentMethod,
      usablePaymentMethodId: attached[0],
      source: 'attached',
    };
  }

  return {
    hasAnyPaymentMethod: false,
    hasDefaultPaymentMethod,
    usablePaymentMethodId: null,
    source: null,
  };
}

/** Normalize Stripe's `string | Expandable<T> | null` payment-method fields. */
export function paymentMethodIdOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
  return null;
}
