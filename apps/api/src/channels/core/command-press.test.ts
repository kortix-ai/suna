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
    expect(pressData({ name: 'model', page: 3 })).toBe('kc:model:p3');
    expect(pressData({ name: 'stop', pick: SESSION })).toBe(`kc:stop:=${SESSION}`);
    expect(Buffer.byteLength(pressData({ name: 'stop', pick: SESSION }))).toBe(45);
  });

  test('data Kortix did not post is no press', () => {
    for (const data of [
      'kc:',
      'kc:nope',
      'kc:sessions',
      'kc:model:p1000',
      'kc:model:=',
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

  test('a ref is d for the project default, else 11 stable base64url characters, distinct across 2,000 ids', () => {
    expect(choiceRef('default')).toBe('d');
    const refs = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const ref = choiceRef(`synthetic/model-${i}`);
      expect(ref).toMatch(/^[A-Za-z0-9_-]{11}$/);
      refs.add(ref);
    }
    expect(refs.size).toBe(2_000);
    expect(choiceRef('synthetic/model-7')).toBe(choiceRef('synthetic/model-7'));
  });
});
