import { describe, expect, test } from 'bun:test';
import {
  buildPickerKeyboard,
  decodePickCallback,
  encodePickCallback,
  isControlCallback,
} from './controls';

describe('control pick encode/decode', () => {
  test('round-trips agent and model values', () => {
    expect(encodePickCallback('agent', 'reviewer')).toBe('kxa:reviewer');
    expect(encodePickCallback('model', 'anthropic/claude-sonnet-5')).toBe(
      'kxm:anthropic/claude-sonnet-5',
    );
    expect(decodePickCallback('kxa:reviewer')).toEqual({ kind: 'agent', value: 'reviewer' });
    expect(decodePickCallback('kxm:anthropic/claude-sonnet-5')).toEqual({
      kind: 'model',
      value: 'anthropic/claude-sonnet-5',
    });
  });

  test('empty value = reset to default', () => {
    expect(decodePickCallback('kxa:')).toEqual({ kind: 'agent', value: '' });
    expect(decodePickCallback('kxm:')).toEqual({ kind: 'model', value: '' });
  });

  test('values containing a colon survive (only the prefix is stripped)', () => {
    expect(decodePickCallback('kxm:openrouter:free/model')).toEqual({
      kind: 'model',
      value: 'openrouter:free/model',
    });
  });

  test('rejects foreign callbacks', () => {
    expect(decodePickCallback(undefined)).toBeNull();
    expect(decodePickCallback('kxq:0:1')).toBeNull();
    expect(decodePickCallback('review_approve_1')).toBeNull();
    expect(isControlCallback('kxa:x')).toBe(true);
    expect(isControlCallback('kxq:0:1')).toBe(false);
  });
});

describe('buildPickerKeyboard', () => {
  test('leads with a Project default reset row, then one option per row', () => {
    const { keyboard } = buildPickerKeyboard(
      'agent',
      [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
      ],
      true,
    );
    expect(keyboard[0]).toEqual([{ text: '✓ Project default', callbackData: 'kxa:' }]);
    expect(keyboard[1]).toEqual([{ text: 'a', callbackData: 'kxa:a' }]);
    expect(keyboard[2]).toEqual([{ text: 'b', callbackData: 'kxa:b' }]);
  });

  test('marks the current option with ✓ (and not default)', () => {
    const { keyboard } = buildPickerKeyboard(
      'model',
      [
        { value: 'x', label: 'X', current: true },
        { value: 'y', label: 'Y' },
      ],
      false,
    );
    expect(keyboard[0][0].text).toBe('Project default'); // no ✓
    expect(keyboard[1][0].text).toBe('✓ X');
    expect(keyboard[2][0].text).toBe('Y');
  });

  test('drops options whose callback_data would exceed 64 bytes', () => {
    const longId = `provider/${'m'.repeat(70)}`;
    const { keyboard, dropped } = buildPickerKeyboard(
      'model',
      [
        { value: 'ok/model', label: 'OK' },
        { value: longId, label: 'TooLong' },
      ],
      true,
    );
    expect(dropped).toEqual([longId]);
    // default row + the one that fits
    expect(keyboard).toHaveLength(2);
    expect(keyboard[1][0].callbackData).toBe('kxm:ok/model');
  });

  test('caps the option count', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `a${i}`, label: `a${i}` }));
    const { keyboard } = buildPickerKeyboard('agent', many, true);
    // 1 default row + at most 12 options
    expect(keyboard.length).toBeLessThanOrEqual(13);
  });
});
