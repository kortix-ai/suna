import { describe, expect, it } from 'bun:test';
// devDependency import — the drift guard is the ONLY place the SDK touches @kortix/shared.
import { HARNESS_IDS } from '@kortix/shared';

import { SDK_HARNESS_IDS } from './harness-mirror';

describe('SDK harness mirror drift guard', () => {
  it('mirrors the canonical @kortix/shared HARNESS_IDS exactly (order included)', () => {
    expect([...SDK_HARNESS_IDS]).toEqual([...HARNESS_IDS]);
  });
});
