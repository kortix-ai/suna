import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultPlanSelection,
  getPlanAction,
  getPlanFamily,
  isCurrentPlan,
} from './plan-action.ts';

test('reads the family from the API plan block before the stored tier key', () => {
  // An admin trial: stored tier_key is still `free`, the plan block says team.
  assert.equal(
    getPlanFamily({ plan: { family: 'team' }, subscription: { tier_key: 'free' } }),
    'team',
  );
  assert.equal(getPlanFamily({ plan: { family: 'enterprise' } }), 'enterprise');
});

test('falls back to the tier key when the API sends no plan block', () => {
  assert.equal(getPlanFamily({ subscription: { tier_key: 'free' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'none' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: '' }, tier: { name: 'free' } }), 'free');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'Enterprise ' } }), 'enterprise');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'per_seat' } }), 'team');
  assert.equal(getPlanFamily({ subscription: { tier_key: 'tier_6_50' } }), 'team');
});

test('treats a missing or loading account state as free', () => {
  assert.equal(getPlanFamily(undefined), 'free');
  assert.equal(getPlanFamily(null), 'free');
  assert.equal(getPlanFamily({ plan: { family: 'unknown' } }), 'free');
});

test('marks the card that matches the current family', () => {
  assert.equal(isCurrentPlan('team', 'team'), true);
  assert.equal(isCurrentPlan('free', 'team'), false);
});

test('preselects Team for a free account and the current plan otherwise', () => {
  assert.equal(defaultPlanSelection('free'), 'team');
  assert.equal(defaultPlanSelection('team'), 'team');
  assert.equal(defaultPlanSelection('enterprise'), 'enterprise');
});

test('picks the button action for the selected plan', () => {
  const owner = { canManageBilling: true };
  const member = { canManageBilling: false };

  assert.equal(getPlanAction({ selected: 'free', current: 'free', ...owner }), 'current');
  assert.equal(getPlanAction({ selected: 'team', current: 'free', ...owner }), 'upgrade');
  assert.equal(getPlanAction({ selected: 'free', current: 'team', ...owner }), 'switch');
  assert.equal(getPlanAction({ selected: 'enterprise', current: 'team', ...owner }), 'contact-sales');

  // A member without billing rights can still see the current plan and contact sales.
  assert.equal(getPlanAction({ selected: 'team', current: 'free', ...member }), 'ask-owner');
  assert.equal(getPlanAction({ selected: 'team', current: 'team', ...member }), 'current');
  assert.equal(getPlanAction({ selected: 'enterprise', current: 'free', ...member }), 'contact-sales');
});
