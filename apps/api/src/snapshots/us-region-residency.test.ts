import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { prepareUsRegionResidency } from './us-region-residency';

let savedRegion: string | undefined;
beforeEach(() => { savedRegion = process.env.KORTIX_PLATINUM_US_REGION; });
afterEach(() => {
  if (savedRegion === undefined) delete process.env.KORTIX_PLATINUM_US_REGION;
  else process.env.KORTIX_PLATINUM_US_REGION = savedRegion;
});

function recorder(result: 'ok' | 'fail' = 'ok') {
  const calls: Array<{ snapshotName: string; region: string }> = [];
  const prepare = async (snapshotName: string, region: string) => {
    calls.push({ snapshotName, region });
    if (result === 'fail') throw new Error('platinum prepare -> 403 region_not_enabled');
    return { templateId: 'tpl_1', region };
  };
  return { calls, prepare };
}

describe('prepareUsRegionResidency', () => {
  test('a Platinum image with a configured US region is made resident there', async () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    const { calls, prepare } = recorder();
    const outcome = await prepareUsRegionResidency('platinum', 'kortix-default-abc', { prepare });
    expect(calls).toEqual([{ snapshotName: 'kortix-default-abc', region: 'us-east' }]);
    expect(outcome).toBe('resident');
  });

  test('no configured US region ⇒ nothing is asked of Platinum', async () => {
    delete process.env.KORTIX_PLATINUM_US_REGION;
    const { calls, prepare } = recorder();
    expect(await prepareUsRegionResidency('platinum', 'kortix-default-abc', { prepare })).toBe('skipped');
    expect(calls).toEqual([]);
  });

  test('another provider ⇒ nothing is asked of Platinum', async () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    const { calls, prepare } = recorder();
    expect(await prepareUsRegionResidency('daytona', 'kortix-default-abc', { prepare })).toBe('skipped');
    expect(calls).toEqual([]);
  });

  test('a failed prepare never throws: the on-demand copy at session create stays the fallback', async () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    const { calls, prepare } = recorder('fail');
    expect(await prepareUsRegionResidency('platinum', 'kortix-default-abc', { prepare })).toBe('failed');
    expect(calls).toHaveLength(1);
  });
});
