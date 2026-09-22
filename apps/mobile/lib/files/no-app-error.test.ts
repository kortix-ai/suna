import { describe, expect, test } from 'bun:test';

import { isNoAppError } from './no-app-error';

describe('isNoAppError', () => {
  test('Android: no activity handles the view intent', () => {
    expect(
      isNoAppError(
        new Error(
          'No Activity found to handle Intent { act=android.intent.action.VIEW dat=content://… typ=application/x-foo }'
        )
      )
    ).toBe(true);
  });

  test('iOS: Quick Look cannot preview the type', () => {
    expect(
      isNoAppError(Object.assign(new Error('cannot preview'), { code: 'UNABLE_TO_OPEN_FILE_TYPE' }))
    ).toBe(true);
  });

  test('any other failure is not a missing app', () => {
    expect(isNoAppError(new Error('IntentLauncher activity is already started.'))).toBe(false);
    expect(isNoAppError(new Error('Network request failed'))).toBe(false);
    expect(isNoAppError(null)).toBe(false);
    expect(isNoAppError('No Activity found')).toBe(false);
  });
});
