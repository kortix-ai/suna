import { describe, expect, test } from 'bun:test';
import { sessionTitleFromMetadata } from './session-title-placeholder';

describe('sessionTitleFromMetadata', () => {
  test('a custom name wins over the generated name', () => {
    expect(sessionTitleFromMetadata({ custom_name: 'Mine', name: 'Generated' })).toBe('Mine');
  });
  test('a blank or non-string custom name falls through to the generated name', () => {
    expect(sessionTitleFromMetadata({ custom_name: '  ', name: 'Generated' })).toBe('Generated');
    expect(sessionTitleFromMetadata({ custom_name: 7, name: 'Generated' })).toBe('Generated');
  });
  test('neither name yields the fallback, null by default, for any metadata shape', () => {
    expect(sessionTitleFromMetadata({ custom_name: '', name: ' ' })).toBeNull();
    expect(sessionTitleFromMetadata({}, 'Untitled session')).toBe('Untitled session');
    for (const metadata of [null, undefined, 'text', 4]) expect(sessionTitleFromMetadata(metadata)).toBeNull();
  });
});
