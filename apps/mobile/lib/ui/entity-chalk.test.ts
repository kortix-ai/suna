import { describe, expect, test } from 'bun:test';
import { chalkColors } from '@kortix/shared';

import { entityChalk } from './entity-chalk';

describe('entityChalk', () => {
  test('seeds chalkColors with the trimmed name, the same seed as web EntityAvatar', () => {
    expect(entityChalk('  Acme Research ')).toEqual(chalkColors('Acme Research'));
  });

  test('gives one project the same colours however its name is padded', () => {
    expect(entityChalk('Project 1')).toEqual(entityChalk(' Project 1\n'));
  });

  test('falls back to the question-mark seed for a blank or missing name', () => {
    expect(entityChalk('   ')).toEqual(chalkColors('?'));
    expect(entityChalk(null)).toEqual(chalkColors('?'));
    expect(entityChalk(undefined)).toEqual(chalkColors('?'));
  });
});
