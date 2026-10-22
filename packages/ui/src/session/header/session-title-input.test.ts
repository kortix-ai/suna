import { describe, expect, test } from 'bun:test';

import { resolveTitleCommit } from './session-title-input';

describe('resolveTitleCommit', () => {
  test('returns the trimmed new name', () => {
    expect(resolveTitleCommit('  Launch plan  ', 'Greeting')).toBe('Launch plan');
  });

  test('an unchanged name saves nothing', () => {
    expect(resolveTitleCommit('Greeting', 'Greeting')).toBeNull();
    expect(resolveTitleCommit(' Greeting ', 'Greeting')).toBeNull();
  });

  test('an empty field saves nothing, so a blur never erases the name', () => {
    expect(resolveTitleCommit('', 'Greeting')).toBeNull();
    expect(resolveTitleCommit('   ', 'Greeting')).toBeNull();
  });
});
