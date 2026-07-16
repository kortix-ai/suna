import { describe, expect, it } from 'bun:test';
// devDependency import — the drift guard is the ONLY place the SDK touches @kortix/shared.
import { HARNESS_IDS, HARNESSES } from '@kortix/shared';

import { SDK_HARNESS_IDS, SDK_HARNESS_STABILITY, type SdkHarnessId } from './harness-mirror';

describe('SDK harness mirror drift guard', () => {
  it('mirrors the canonical @kortix/shared HARNESS_IDS exactly (order included)', () => {
    expect([...SDK_HARNESS_IDS]).toEqual([...HARNESS_IDS]);
  });

  it('mirrors the canonical @kortix/shared HARNESSES[id].stability exactly', () => {
    const expected = Object.fromEntries(
      HARNESS_IDS.map((id) => [id, HARNESSES[id].stability]),
    ) as Record<SdkHarnessId, 'stable' | 'experimental'>;
    expect(SDK_HARNESS_STABILITY).toEqual(expected);
  });
});
