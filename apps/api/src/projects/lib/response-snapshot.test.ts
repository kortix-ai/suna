import { describe, expect, test } from 'bun:test';
import { RESPONSE_NOT_FOUND_ERROR, RESPONSE_SAVING_ERROR, unloggedTurnResult } from './response-snapshot';

describe('unloggedTurnResult', () => {
  test('a turn the ledger recorded but the log has not received yet → 409, retry', () => {
    expect(unloggedTurnResult(true)).toEqual({ ok: false, status: 409, error: RESPONSE_SAVING_ERROR });
  });

  test('a turn nobody recorded → 404', () => {
    expect(unloggedTurnResult(false)).toEqual({ ok: false, status: 404, error: RESPONSE_NOT_FOUND_ERROR });
  });
});
