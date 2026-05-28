import { describe, expect, test } from 'bun:test';
import { partContentToText, partToText } from './share-message-text';

describe('partContentToText', () => {
  test('returns a plain string as-is', () => {
    expect(partContentToText('hello')).toBe('hello');
  });

  test('reads text from a { text } object', () => {
    expect(partContentToText({ text: 'hi' })).toBe('hi');
  });

  test('joins an array of strings and { text } objects', () => {
    expect(partContentToText(['a', { text: 'b' }, 'c'])).toBe('abc');
  });

  test('returns empty string for null/undefined/non-text objects', () => {
    expect(partContentToText(null)).toBe('');
    expect(partContentToText(undefined)).toBe('');
    expect(partContentToText({ foo: 1 })).toBe('');
    expect(partContentToText(42)).toBe('');
  });
});

describe('partToText', () => {
  test('prefers part.text when present', () => {
    expect(partToText({ text: 'direct', content: { text: 'ignored' } })).toBe('direct');
  });

  test('falls back to string content (previously dropped)', () => {
    expect(partToText({ content: 'from-content' })).toBe('from-content');
  });

  test('falls back to content.text', () => {
    expect(partToText({ content: { text: 'nested' } })).toBe('nested');
  });

  test('returns empty string when there is no text anywhere', () => {
    expect(partToText({})).toBe('');
    expect(partToText({ text: '', content: null })).toBe('');
  });
});
