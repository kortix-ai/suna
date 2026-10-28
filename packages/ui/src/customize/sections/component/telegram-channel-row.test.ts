import { describe, expect, test } from 'bun:test';
import { parseTelegramUserIds } from './telegram-channel-row';
import { parseTelegramUserId, telegramUserName } from './telegram-users-panel';

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

describe('parseTelegramUserId', () => {
  test('accepts one numeric id and trims the spaces around it', () => {
    expect(parseTelegramUserId(' 100200300 ')).toBe('100200300');
    expect(parseTelegramUserId('1'.repeat(20))).toBe('1'.repeat(20));
  });

  test('refuses an empty value, a handle, a list and an id over 20 digits', () => {
    for (const raw of ['', '   ', '@someone', '12a', '-5', '1 2', '1,2', '1'.repeat(21)]) {
      expect(parseTelegramUserId(raw)).toBeNull();
    }
  });
});

describe('telegramUserName', () => {
  const user = { user_id: '100200300', username: 'sample_user', first_name: 'Sam', last_name: 'Sample' };

  test('shows first and last name first', () => {
    expect(telegramUserName(user)).toBe('Sam Sample');
    expect(telegramUserName({ ...user, last_name: null })).toBe('Sam');
    expect(telegramUserName({ ...user, first_name: null })).toBe('Sample');
  });

  test('falls back to @username, then to the id', () => {
    expect(telegramUserName({ ...user, first_name: null, last_name: null })).toBe('@sample_user');
    expect(telegramUserName({ ...user, first_name: '', last_name: null, username: null })).toBe('100200300');
  });
});
