import { describe, expect, test } from 'bun:test';
import { choiceRef, isCommandPressData, parsePressData, pressData, type CommandPress } from './command-press';

// A command button's data is persisted in chats: a menu posted before a deploy
// must still parse after it.

const SESSION = '00000000-0000-4000-8000-000000000000';

describe('command button data', () => {
  test('every press round-trips, in at most 64 bytes', () => {
    const presses: CommandPress[] = [
      { name: 'help' },
      { name: 'model', page: 3 },
      { name: 'model', page: 100 },
      { name: 'agent', page: 999 },
      { name: 'model', pick: 'd' },
      { name: 'agent', pick: choiceRef('reviewer') },
      { name: 'stop', pick: SESSION },
    ];
    for (const press of presses) {
      const data = pressData(press);
      expect(isCommandPressData(data)).toBe(true);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parsePressData(data)).toEqual(press);
    }
  });

  test('data Kortix did not post is no press', () => {
    for (const data of [
      'kc:',
      'kc:model:p1000',
      'kc:model:x1',
      'kc:model:=a b',
      `kc:model:=${'a'.repeat(55)}`,
      `kq:${SESSION}:0`,
      '',
    ]) {
      expect(parsePressData(data)).toBeNull();
    }
    expect(isCommandPressData(`kq:${SESSION}:0`)).toBe(false);
  });

  test('a press that would not parse back throws', () => {
    expect(() => pressData({ name: 'stop', pick: 'x'.repeat(56) })).toThrow();
  });

  test('a ref is 11 base64url characters, so a pick token stays at 21 bytes', () => {
    expect(choiceRef('synthetic/model-7')).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });
});
