import assert from 'node:assert/strict';
import test from 'node:test';

import { getUpgradeSheetTransition } from './upgrade-sheet-lifecycle.ts';

test('does not dismiss an upgrade sheet that has never been presented', () => {
  assert.equal(getUpgradeSheetTransition(false, false), 'none');
});

test('presents an opened sheet and dismisses it only after it was presented', () => {
  assert.equal(getUpgradeSheetTransition(true, false), 'present');
  assert.equal(getUpgradeSheetTransition(false, true), 'dismiss');
});
