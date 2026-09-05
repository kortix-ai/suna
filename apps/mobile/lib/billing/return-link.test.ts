import { describe, expect, test } from 'bun:test';
import { APP_SCHEME, buildSuccessUrl, buildCancelUrl, parseBillingReturn } from './return-link';

describe('billing return-link builders', () => {
  test('success url with context', () => {
    expect(buildSuccessUrl('plan')).toBe('agentpress://billing/success?context=plan');
  });
  test('success url default context', () => {
    expect(buildSuccessUrl()).toBe('agentpress://billing/success?context=checkout');
  });
  test('cancel url', () => {
    expect(buildCancelUrl()).toBe('agentpress://billing/cancel');
  });
  test('scheme is agentpress', () => {
    expect(APP_SCHEME).toBe('agentpress://');
  });
});

describe('parseBillingReturn', () => {
  test('success with context', () => {
    expect(parseBillingReturn('agentpress://billing/success?context=plan')).toEqual({
      kind: 'success',
      context: 'plan',
    });
  });
  test('success without context', () => {
    expect(parseBillingReturn('agentpress://billing/success')).toEqual({
      kind: 'success',
      context: null,
    });
  });
  test('cancel', () => {
    expect(parseBillingReturn('agentpress://billing/cancel')).toEqual({
      kind: 'cancel',
      context: null,
    });
  });
  test('credits context round-trips through the builder', () => {
    expect(parseBillingReturn(buildSuccessUrl('credits'))).toEqual({
      kind: 'success',
      context: 'credits',
    });
  });
  test('unrelated deep link → null', () => {
    expect(parseBillingReturn('agentpress://auth/callback?code=abc')).toEqual({
      kind: null,
      context: null,
    });
  });
  test('empty / garbage → null', () => {
    expect(parseBillingReturn('')).toEqual({ kind: null, context: null });
    expect(parseBillingReturn('not a url')).toEqual({ kind: null, context: null });
  });
});
