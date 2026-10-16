import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canManageBilling,
  defaultPlanSelection,
  getPlanAction,
  getPlanFamily,
  isCurrentPlan,
} from './plan-action.ts';

test('reads the family from the API plan block before the stored tier key', () => {
  // An admin trial: stored tier_key is still `free`, the plan block says credits.
  assert.equal(
    getPlanFamily({ plan: { family: 'credits' }, subscription: { tier_key: 'free' } }),
    'credits',
  );
  assert.equal(getPlanFamily({ plan: { family: 'enterprise' } }), 'enterprise');
});

test('falls back to the tier key when the API sends no plan block', () => {
  assert.equal(getPlanFamily({ subscription: { tier_key: 'free' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'none' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: '' }, tier: { name: 'free' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'Enterprise ' } }), 'enterprise');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'per_seat' } }), 'credits');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'tier_6_50' } }), 'credits');
});

test('treats a missing or loading account state as free', () => {
  assert.equal(getPlanFamily(undefined), 'free');
  assert.equal(getPlanFamily(null), 'free');
  assert.equal(getPlanFamily({ plan: { family: 'unknown' } }), 'free');
});

test('marks the card that matches the current family', () => {
  assert.equal(isCurrentPlan('credits', 'credits'), true);
  assert.equal(isCurrentPlan('free', 'credits'), false);
});

test('preselects Credits for a free account and the current plan otherwise', () => {
  assert.equal(defaultPlanSelection('free'), 'credits');
  assert.equal(defaultPlanSelection('credits'), 'credits');
  assert.equal(defaultPlanSelection('enterprise'), 'enterprise');
});

test('picks the button action for the selected plan', () => {
  const owner = { canManageBilling: true };
  const member = { canManageBilling: false };

  assert.equal(getPlanAction({ selected: 'free', current: 'free', ...owner }), 'current');
  assert.equal(getPlanAction({ selected: 'credits', current: 'free', ...owner }), 'upgrade');
  assert.equal(getPlanAction({ selected: 'free', current: 'credits', ...owner }), 'switch');
  assert.equal(getPlanAction({ selected: 'enterprise', current: 'credits', ...owner }), 'contact-sales');

  // A member without billing rights can still see the current plan and contact sales.
  assert.equal(getPlanAction({ selected: 'credits', current: 'free', ...member }), 'ask-owner');
  assert.equal(getPlanAction({ selected: 'credits', current: 'credits', ...member }), 'current');
  assert.equal(getPlanAction({ selected: 'enterprise', current: 'free', ...member }), 'contact-sales');
});

test('billing management is allowed unless the API says otherwise', () => {
  assert.equal(canManageBilling(undefined), true);
  assert.equal(canManageBilling({}), true);
  assert.equal(canManageBilling({ can_manage_billing: false }), false);
});
