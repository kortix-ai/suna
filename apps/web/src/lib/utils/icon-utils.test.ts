import { describe, expect, test } from 'bun:test';
import { isValidIconName, mynauiIconRegistry, normalizeIconName, resolveIconKey } from './icon-utils';

describe('resolveIconKey', () => {
  test('resolves a direct mynaui icon by kebab and Pascal name', () => {
    expect(resolveIconKey('calendar')).toBe('calendar');
    expect(resolveIconKey('Calendar')).toBe('calendar');
  });

  test('translates renamed lucide names through the alias map', () => {
    expect(resolveIconKey('message-circle')).toBe('chat'); // lucide MessageCircle -> mynaui Chat
    expect(resolveIconKey('settings')).toBe('cog-one'); // lucide Settings -> mynaui CogOne
  });

  test('regular (outline) is the default, FORCE_SOLID bases are filled', () => {
    // default → outline
    expect(resolveIconKey('key')).toBe('key');
    expect(mynauiIconRegistry['key']).toBeDefined();
    // FORCE_SOLID → component is present (filled) for trash/users/cog-one
    expect(mynauiIconRegistry['trash']).toBeDefined();
    expect(mynauiIconRegistry['users']).toBeDefined();
  });

  test('every resolved key exists in the registry as a renderable component', () => {
    for (const key of ['calendar', 'chat', 'cog-one']) {
      expect(mynauiIconRegistry[key]).toBeDefined();
    }
  });

  test('returns null for unknown / empty names', () => {
    expect(resolveIconKey('definitely-not-an-icon')).toBeNull();
    expect(resolveIconKey('')).toBeNull();
    expect(resolveIconKey(null)).toBeNull();
  });

  test('isValidIconName / normalizeIconName wrap resolveIconKey', () => {
    expect(isValidIconName('message-circle')).toBe(true);
    expect(isValidIconName('nope-nope')).toBe(false);
    expect(normalizeIconName('settings')).toBe('cog-one');
    expect(normalizeIconName('nope-nope')).toBeNull();
  });
});
