import { describe, expect, test } from 'bun:test';

import { cn } from './utils';

describe('cn shadow composition', () => {
  test('keeps the last native shadow size', () => {
    expect(cn('shadow-sm', 'shadow-md', 'shadow-lg')).toBe('shadow-lg');
  });

  test('lets shadow-none remove a native elevation class', () => {
    expect(cn('shadow-lg', 'shadow-none')).toBe('shadow-none');
  });

  test('preserves independent shadow and smooth-ring colors', () => {
    expect(cn('shadow-md', 'shadow-black/20', 'smooth-ring-neutral-400/40')).toBe(
      'shadow-md shadow-black/20 smooth-ring-neutral-400/40',
    );
  });

  test('does not merge native and explicit plugin sizes', () => {
    expect(cn('shadow-md', 'smooth-shadow-ring-xl')).toBe('shadow-md smooth-shadow-ring-xl');
  });
});
