import { describe, expect, test } from 'bun:test';
import {
  PLATINUM_PROJECT_IMAGE_MIN_RESERVE,
  PLATINUM_PROJECT_IMAGE_RESERVE_FRACTION,
  assessFastProjectImageBuildAdmission,
  platinumProjectImageReserve,
} from './project-image-admission';

function provider(
  id: string,
  capacity?: () => Promise<{ used: number; cap: number }>,
) {
  return {
    id,
    getSnapshotBuildCapacity: capacity,
  };
}

describe('platinumProjectImageReserve', () => {
  test('keeps ten percent or ten slots, whichever is greater', () => {
    expect(PLATINUM_PROJECT_IMAGE_RESERVE_FRACTION).toBe(0.1);
    expect(PLATINUM_PROJECT_IMAGE_MIN_RESERVE).toBe(10);
    expect(platinumProjectImageReserve(500)).toBe(50);
    expect(platinumProjectImageReserve(50)).toBe(10);
    expect(platinumProjectImageReserve(5)).toBe(5);
  });
});

describe('assessFastProjectImageBuildAdmission', () => {
  test('allows Platinum only while the next image stays outside the reserve', async () => {
    await expect(
      assessFastProjectImageBuildAdmission(provider('platinum', async () => ({ used: 449, cap: 500 }))),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
      used: 449,
      cap: 500,
      reserve: 50,
    });

    await expect(
      assessFastProjectImageBuildAdmission(provider('platinum', async () => ({ used: 450, cap: 500 }))),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'provider_reserve_reached',
      used: 450,
      cap: 500,
      reserve: 50,
    });
  });

  test('fails closed when Platinum cannot provide authoritative capacity', async () => {
    await expect(
      assessFastProjectImageBuildAdmission(provider('platinum')),
    ).resolves.toEqual({ allowed: false, reason: 'capacity_unavailable' });

    await expect(
      assessFastProjectImageBuildAdmission(
        provider('platinum', async () => {
          throw new Error('quota unavailable');
        }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'capacity_check_failed' });
  });

  test('uses Daytona complete-view admission without deleting', async () => {
    let calls = 0;
    const assessDaytona = async () => {
      calls++;
      return { allowed: true, reason: 'allowed' as const };
    };

    await expect(
      assessFastProjectImageBuildAdmission(provider('daytona'), { assessDaytona }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(calls).toBe(1);
  });

  test('preserves Daytona denial reasons and fails closed on assessment errors', async () => {
    await expect(
      assessFastProjectImageBuildAdmission(provider('daytona'), {
        assessDaytona: async () => ({ allowed: false, reason: 'org_target_reached' }),
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'daytona_org_target_reached',
    });

    await expect(
      assessFastProjectImageBuildAdmission(provider('daytona'), {
        assessDaytona: async () => {
          throw new Error('Daytona unavailable');
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'capacity_check_failed' });
  });

  test('preserves existing E2B project-image writes without a shared hard-cap contract', async () => {
    await expect(
      assessFastProjectImageBuildAdmission(provider('e2b')),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
  });

  test('fails closed for unknown providers', async () => {
    await expect(
      assessFastProjectImageBuildAdmission(provider('unknown')),
    ).resolves.toEqual({ allowed: false, reason: 'capacity_unavailable' });
  });
});
