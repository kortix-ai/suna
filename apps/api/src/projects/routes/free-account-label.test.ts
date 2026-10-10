import { describe, expect, test } from 'bun:test';

import { freeAccountLabel } from './connection-actions';

describe('freeAccountLabel', () => {
  test('keeps a free name, numbers a taken one', () => {
    expect(freeAccountLabel('Miro', [])).toBe('Miro');
    expect(freeAccountLabel('Miro', ['miro', 'Miro 2'])).toBe('Miro 3');
  });

  test('a taken 255-character name still fits the label column once numbered', () => {
    const long = 'x'.repeat(255);
    const label = freeAccountLabel(long, [long]);
    expect(label.length).toBeLessThanOrEqual(255);
    expect(label.endsWith(' 2')).toBe(true);
  });
});
