import { expect, test } from 'bun:test';
import { conversationName } from './session-participants';

test('a conversation is named by the first line, cut at a word with an ellipsis', () => {
  expect(conversationName('Which region?\nContext follows.')).toBe('Which region?');
  const long = 'Dev check: which color should the release badge be, green or blue? Reply with one word.';
  const name = conversationName(long);
  expect(name).toBe('Dev check: which color should the release badge be, green or blue? Reply with…');
  expect(name.length).toBeLessThanOrEqual(80);
  expect(conversationName('x'.repeat(120))).toBe(`${'x'.repeat(79)}…`);
});
