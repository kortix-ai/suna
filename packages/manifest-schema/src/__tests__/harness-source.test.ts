import { describe, it, expect } from 'bun:test';
import { HARNESS_IDS } from '@kortix/shared';
import { V3_HARNESS_VALUES } from '../constants';

describe('V3 harness enum derives from @kortix/shared', () => {
  it('is exactly the canonical HARNESS_IDS tuple', () => {
    expect([...V3_HARNESS_VALUES]).toEqual([...HARNESS_IDS]);
  });
});
