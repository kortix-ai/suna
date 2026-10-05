import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINAL_CONFIRM_ARM_DELAY_MS,
  canConfirmDeletion,
  canContinueToFinal,
  matchesConfirmWord,
} from './confirm-flow.ts';

const WORD = 'DELETE';

test('accepts the confirm word in any case, with surrounding spaces', () => {
  assert.equal(matchesConfirmWord('DELETE', WORD), true);
  assert.equal(matchesConfirmWord('delete', WORD), true);
  assert.equal(matchesConfirmWord('  Delete ', WORD), true);
});

test('rejects anything that is not exactly the confirm word', () => {
  assert.equal(matchesConfirmWord('', WORD), false);
  assert.equal(matchesConfirmWord('DELET', WORD), false);
  assert.equal(matchesConfirmWord('DELETE ME', WORD), false);
  assert.equal(matchesConfirmWord('D E L E T E', WORD), false);
  // A missing translation must never turn an empty field into a match.
  assert.equal(matchesConfirmWord('', ''), false);
  assert.equal(matchesConfirmWord('  ', ' '), false);
});

test('Continue needs the typed word and no request in flight', () => {
  assert.equal(canContinueToFinal({ input: '', word: WORD, busy: false }), false);
  assert.equal(canContinueToFinal({ input: 'delete', word: WORD, busy: false }), true);
  assert.equal(canContinueToFinal({ input: 'delete', word: WORD, busy: true }), false);
});

test('taps alone never delete: step 1 with no word cannot confirm', () => {
  // Tap "Delete account", then tap the destructive button twice without typing.
  for (const armed of [false, true]) {
    assert.equal(
      canConfirmDeletion({ step: 'type', input: '', word: WORD, armed, busy: false }),
      false,
    );
  }
});

test('the typed word alone does not delete: step 1 cannot confirm', () => {
  assert.equal(
    canConfirmDeletion({ step: 'type', input: 'DELETE', word: WORD, armed: true, busy: false }),
    false,
  );
});

test('a double tap on Continue lands on a disarmed Delete button', () => {
  assert.equal(
    canConfirmDeletion({ step: 'final', input: 'DELETE', word: WORD, armed: false, busy: false }),
    false,
  );
  assert.ok(FINAL_CONFIRM_ARM_DELAY_MS >= 500);
});

test('Delete works only on the armed final step, with the word, and once', () => {
  assert.equal(
    canConfirmDeletion({ step: 'final', input: 'DELETE', word: WORD, armed: true, busy: false }),
    true,
  );
  assert.equal(
    canConfirmDeletion({ step: 'final', input: 'DELETE', word: WORD, armed: true, busy: true }),
    false,
  );
  assert.equal(
    canConfirmDeletion({ step: 'final', input: 'nope', word: WORD, armed: true, busy: false }),
    false,
  );
});
