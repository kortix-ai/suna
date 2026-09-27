import { describe, expect, test } from 'bun:test';
import { sheetOpenMove } from './sheet-open';

describe('sheetOpenMove', () => {
  test('open: present the sheet', () => {
    expect(sheetOpenMove(true, false)).toBe('present');
  });

  test('not on screen (closed at mount, or it already dismissed itself): do nothing — dismiss() on a gorhom modal that is not presented blocks its next present', () => {
    expect(sheetOpenMove(false, false)).toBe('none');
  });

  test('closed by the parent while the sheet is on screen: dismiss it', () => {
    expect(sheetOpenMove(false, true)).toBe('dismiss');
  });
});
