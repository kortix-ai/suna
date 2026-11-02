// A create the fleet refused for room gets two quick retries (1 s, then 2 s)
// before the session's next `/start` takes over with its own backoff. Quota-type
// "capacity" (an org pool, an org limit, a full disk) still fails on the first
// refusal: it does not clear in seconds.
import { describe, expect, test } from 'bun:test';
import type { CreateSandboxOpts, ProvisionResult, SandboxProvider } from '../providers';
import { CAPACITY_QUICK_RETRY_DELAYS_MS, isFleetPlacementRefusal, retrySandboxProvisionCreate } from './sandbox-init-state';

const FLEET_FULL =
  'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 503 {"error":"no capacity on a host that can mount these volumes","code":"capacity","region":"eu-west","pinned_host":null}';
const PLAIN_NO_CAPACITY =
  'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 503 {"error":"no capacity","code":"capacity","region":"eu-west"}';
const ORG_POOL_FULL = 'platinum POST /v1/sandboxes -> 429 {"error":"resource pool exhausted for this organization"}';

const created: ProvisionResult = { externalId: 'sbx_new' } as unknown as ProvisionResult;
const provider = {} as SandboxProvider;
const opts = {} as CreateSandboxOpts;

function scripted(failures: string[]) {
  let calls = 0;
  const createFn = async () => {
    const failure = failures[calls++];
    if (failure) throw new Error(failure);
    return created;
  };
  return { createFn, calls: () => calls };
}

function recorder() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => void slept.push(ms), slept };
}

describe('retrySandboxProvisionCreate on a capacity refusal', () => {
  test('a fleet refusal that clears on the second attempt lands after one 1 s retry', async () => {
    const { createFn, calls } = scripted([FLEET_FULL]);
    const { sleep, slept } = recorder();
    const failures: Array<{ attempt: number; willRetry: boolean; max: number }> = [];
    const out = await retrySandboxProvisionCreate(
      provider,
      opts,
      { onAttemptFailure: (attempt, _e, willRetry, max) => void failures.push({ attempt, willRetry, max }) },
      createFn,
      sleep,
    );
    expect(out).toEqual({ result: created, attempts: 2 });
    expect(calls()).toBe(2);
    expect(slept).toEqual([1_000]);
    expect(failures).toEqual([{ attempt: 1, willRetry: true, max: 3 }]);
  });

  test('a fleet that stays full fails after three attempts and ~3 s, for /start to take over', async () => {
    const { createFn, calls } = scripted([FLEET_FULL, PLAIN_NO_CAPACITY, FLEET_FULL, FLEET_FULL]);
    const { sleep, slept } = recorder();
    await expect(retrySandboxProvisionCreate(provider, opts, {}, createFn, sleep)).rejects.toThrow(/no capacity/);
    expect(calls()).toBe(1 + CAPACITY_QUICK_RETRY_DELAYS_MS.length);
    expect(slept).toEqual([1_000, 2_000]);
  });

  test('an org pool refusal still fails on the first attempt', async () => {
    const { createFn, calls } = scripted([ORG_POOL_FULL, ORG_POOL_FULL]);
    const { sleep, slept } = recorder();
    await expect(retrySandboxProvisionCreate(provider, opts, {}, createFn, sleep)).rejects.toThrow(/resource pool exhausted/);
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  test('only fleet placement refusals qualify', () => {
    expect(isFleetPlacementRefusal(new Error(FLEET_FULL))).toBe(true);
    expect(isFleetPlacementRefusal(new Error(PLAIN_NO_CAPACITY))).toBe(true);
    expect(isFleetPlacementRefusal(new Error('too many starts in flight'))).toBe(true);
    expect(isFleetPlacementRefusal(new Error(ORG_POOL_FULL))).toBe(false);
    expect(isFleetPlacementRefusal(new Error('maximum number of concurrent sandboxes reached'))).toBe(false);
    expect(isFleetPlacementRefusal(new Error('total disk limit exceeded'))).toBe(false);
  });
});
