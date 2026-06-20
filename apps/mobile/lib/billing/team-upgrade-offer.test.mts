import assert from 'node:assert/strict';
import test from 'node:test';

import { getTeamUpgradeOffer } from './team-upgrade-offer.ts';

test('uses the account’s per-seat price and member count for a team checkout', () => {
  assert.deepEqual(
    getTeamUpgradeOffer({
      can_manage_billing: true,
      member_count: 3,
      seats: { count: 2, price_per_seat_usd: 25 },
    }),
    {
      canManageBilling: true,
      pricePerSeat: 25,
      seatCount: 3,
      monthlyTotal: 75,
      hasSeatMath: true,
    },
  );
});

test('uses the web checkout fallback for a loading or incomplete account state', () => {
  assert.deepEqual(getTeamUpgradeOffer(undefined), {
    canManageBilling: true,
    pricePerSeat: 40,
    seatCount: 1,
    monthlyTotal: 40,
    hasSeatMath: false,
  });
});

test('prevents members from being offered a checkout they cannot manage', () => {
  assert.equal(
    getTeamUpgradeOffer({ can_manage_billing: false }).canManageBilling,
    false,
  );
});
