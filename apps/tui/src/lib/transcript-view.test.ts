import { describe, expect, test } from 'bun:test';

import { formatElapsed, lastTextMessage, messageText, oneLine } from './transcript-view.ts';

const user = { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hello ' }] };
const toolOnly = { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'tool' }] };
const reply = {
  info: { id: 'm3', role: 'assistant' },
  parts: [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hi' },
    { type: 'text', text: ' there' },
  ],
};

describe('messageText', () => {
  test('joins text parts and trims', () => {
    expect(messageText(user)).toBe('hello');
    expect(messageText(reply)).toBe('hi there');
  });

  test('a message with no text part is empty', () => {
    expect(messageText(toolOnly)).toBe('');
  });
});

describe('lastTextMessage', () => {
  test('returns the newest message that has text', () => {
    expect(lastTextMessage([user, reply, toolOnly])?.info.id).toBe('m3');
  });

  test('returns null when nothing has text', () => {
    expect(lastTextMessage([toolOnly])).toBeNull();
    expect(lastTextMessage([])).toBeNull();
  });
});

describe('oneLine', () => {
  test('collapses whitespace', () => {
    expect(oneLine('a\n  b\tc ', 80)).toBe('a b c');
  });

  test('truncates with an ellipsis at the width', () => {
    expect(oneLine('abcdefghij', 5)).toBe('abcd…');
    expect(oneLine('abc', 5)).toBe('abc');
  });
});

describe('formatElapsed', () => {
  test('seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
  });

  test('minutes and zero-padded seconds above', () => {
    expect(formatElapsed(64_000)).toBe('1m 04s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
  });
});
