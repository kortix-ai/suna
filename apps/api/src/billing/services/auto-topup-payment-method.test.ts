import { describe, expect, test } from 'bun:test';
import { paymentMethodIdOf, resolveUsablePaymentMethod } from './auto-topup-payment-method';

describe('resolveUsablePaymentMethod — non-card checkouts are not "no payment method"', () => {
  test('a Link customer with only a subscription-level default resolves to that method', () => {
    const result = resolveUsablePaymentMethod({
      customerDefaultPaymentMethodId: null,
      subscriptionDefaultPaymentMethodId: 'pm_link',
      attachedPaymentMethodIds: [],
    });
    expect(result.hasAnyPaymentMethod).toBe(true);
    expect(result.hasDefaultPaymentMethod).toBe(true);
    expect(result.usablePaymentMethodId).toBe('pm_link');
    expect(result.source).toBe('subscription_default');
  });

  test('a non-card method attached to the customer is usable even with no default anywhere', () => {
    const result = resolveUsablePaymentMethod({
      customerDefaultPaymentMethodId: null,
      subscriptionDefaultPaymentMethodId: null,
      attachedPaymentMethodIds: ['pm_sepa'],
    });
    expect(result.hasAnyPaymentMethod).toBe(true);
    expect(result.hasDefaultPaymentMethod).toBe(false);
    expect(result.usablePaymentMethodId).toBe('pm_sepa');
    expect(result.source).toBe('attached');
  });

  test('the customer-level invoice default still wins over everything else', () => {
    const result = resolveUsablePaymentMethod({
      customerDefaultPaymentMethodId: 'pm_customer',
      subscriptionDefaultPaymentMethodId: 'pm_subscription',
      attachedPaymentMethodIds: ['pm_attached'],
    });
    expect(result.usablePaymentMethodId).toBe('pm_customer');
    expect(result.source).toBe('customer_default');
  });

  test('the subscription default outranks an arbitrary attached method', () => {
    const result = resolveUsablePaymentMethod({
      subscriptionDefaultPaymentMethodId: 'pm_subscription',
      attachedPaymentMethodIds: ['pm_attached'],
    });
    expect(result.usablePaymentMethodId).toBe('pm_subscription');
  });

  test('a customer with genuinely nothing saved resolves to no payment method', () => {
    const result = resolveUsablePaymentMethod({
      customerDefaultPaymentMethodId: null,
      subscriptionDefaultPaymentMethodId: null,
      attachedPaymentMethodIds: [],
    });
    expect(result).toEqual({
      hasAnyPaymentMethod: false,
      hasDefaultPaymentMethod: false,
      usablePaymentMethodId: null,
      source: null,
    });
  });

  test('empty-string ids are treated as absent, not as a usable method', () => {
    const result = resolveUsablePaymentMethod({
      customerDefaultPaymentMethodId: '',
      subscriptionDefaultPaymentMethodId: '',
      attachedPaymentMethodIds: [''],
    });
    expect(result.hasAnyPaymentMethod).toBe(false);
    expect(result.usablePaymentMethodId).toBeNull();
  });
});

describe('paymentMethodIdOf', () => {
  test('reads a bare id string', () => {
    expect(paymentMethodIdOf('pm_1')).toBe('pm_1');
  });

  test('reads an expanded payment-method object', () => {
    expect(paymentMethodIdOf({ id: 'pm_2', type: 'link' })).toBe('pm_2');
  });

  test('null / undefined / empty resolve to null', () => {
    expect(paymentMethodIdOf(null)).toBeNull();
    expect(paymentMethodIdOf(undefined)).toBeNull();
    expect(paymentMethodIdOf('')).toBeNull();
    expect(paymentMethodIdOf({})).toBeNull();
  });
});
