import { describe, expect, test } from 'bun:test';
import { parseTelegramUserIds } from './telegram-channel-row';

describe('parseTelegramUserIds', () => {
  test('accepts numeric ids separated by commas or spaces, and an empty list', () => {
    expect(parseTelegramUserIds('1, 22  333,4444')).toEqual(['1', '22', '333', '4444']);
    expect(parseTelegramUserIds('  ')).toEqual([]);
  });

  test('refuses anything that is not a numeric id', () => {
    expect(parseTelegramUserIds('123, @someone')).toBeNull();
    expect(parseTelegramUserIds('12a')).toBeNull();
  });
});
