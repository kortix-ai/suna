import { expect, test } from 'bun:test';
import { customerStatus } from './sales-customer';

const free = { complete: true, unsupported: false, subscriptions: [{ status: 'active', amount: 0 }] };
test('affirmative zero-dollar evidence permits outreach; missing evidence does not', () => {
  expect(customerStatus([free])).toBe(false);
  expect(customerStatus([])).toBeNull();
  expect(customerStatus([{ ...free, complete: false }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [] }])).toBeNull();
});
test('current paid membership suppresses whole user even when another membership is unknown', () => {
  expect(customerStatus([{ ...free, unsupported: true }, { ...free, subscriptions: [{ status: 'active', amount: 50 }] }])).toBe(true);
});
test('trials, unsupported providers, unknown prices and incomplete pagination hold for review', () => {
  expect(customerStatus([{ ...free, unsupported: true }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'trialing', amount: 50 }] }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'active', amount: null }] }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'active', amount: Number.NaN }] }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'active', amount: Number.POSITIVE_INFINITY }] }])).toBeNull();
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'active', amount: -1 }] }])).toBeNull();
  expect(customerStatus([free, { ...free, complete: false }])).toBeNull();
});
test('verified lapsed subscriptions permit outreach but delinquency is ambiguous', () => {
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'canceled', amount: 50 }] }])).toBe(false);
  expect(customerStatus([{ ...free, subscriptions: [{ status: 'past_due', amount: 50 }] }])).toBeNull();
});
