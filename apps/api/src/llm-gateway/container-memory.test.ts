import { describe, expect, test } from 'bun:test';

import {
  INFLIGHT_BUDGET_FRACTION,
  deriveInflightBudgetBytes,
  detectContainerMemoryLimitBytes,
} from './container-memory';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A fake filesystem: only the paths given exist. */
const fsWith = (files: Record<string, string>) => ({
  read: (path: string): string | null => files[path] ?? null,
});

describe('detectContainerMemoryLimitBytes', () => {
  test('reads the cgroup v2 limit', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory.max': `${2 * GiB}\n` }),
      totalMemory: () => 64 * GiB,
    });
    expect(limit).toBe(2 * GiB);
  });

  test('reads the cgroup v1 limit when v2 is absent', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${640 * MiB}` }),
      totalMemory: () => 64 * GiB,
    });
    expect(limit).toBe(640 * MiB);
  });

  // cgroup v2 writes the literal string "max" when the container is unlimited,
  // and v1 writes a number near 2^63. Treating either as a real limit would
  // hand the budget an astronomical ceiling.
  test('cgroup v2 "max" means unlimited — falls back to host memory', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory.max': 'max\n' }),
      totalMemory: () => 8 * GiB,
    });
    expect(limit).toBe(8 * GiB);
  });

  test('an absurd cgroup v1 sentinel means unlimited — falls back to host memory', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
      totalMemory: () => 8 * GiB,
    });
    expect(limit).toBe(8 * GiB);
  });

  test('a cgroup limit LARGER than host memory is not believed', () => {
    // Seen on some runtimes; the honest ceiling is whichever is smaller.
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory.max': `${128 * GiB}` }),
      totalMemory: () => 4 * GiB,
    });
    expect(limit).toBe(4 * GiB);
  });

  test('no cgroup at all (macOS dev) falls back to host memory', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({}),
      totalMemory: () => 16 * GiB,
    });
    expect(limit).toBe(16 * GiB);
  });

  test('unreadable garbage never throws and never returns a bogus number', () => {
    const limit = detectContainerMemoryLimitBytes({
      read: () => {
        throw new Error('permission denied');
      },
      totalMemory: () => 2 * GiB,
    });
    expect(limit).toBe(2 * GiB);
  });

  test('a non-numeric cgroup value is ignored', () => {
    const limit = detectContainerMemoryLimitBytes({
      ...fsWith({ '/sys/fs/cgroup/memory.max': 'not-a-number' }),
      totalMemory: () => 2 * GiB,
    });
    expect(limit).toBe(2 * GiB);
  });
});

describe('deriveInflightBudgetBytes', () => {
  // The property that matters: the budget is always a FRACTION of the memory the
  // process actually has, whatever that turns out to be. That is what makes a
  // stale rendered compose file harmless — the process reads reality, not a file.
  test('scales vertically with the container', () => {
    const small = deriveInflightBudgetBytes(640 * MiB);
    const medium = deriveInflightBudgetBytes(2 * GiB);
    const large = deriveInflightBudgetBytes(8 * GiB);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  test('never exceeds the configured fraction of the container', () => {
    for (const limit of [256 * MiB, 640 * MiB, 1 * GiB, 2 * GiB, 4 * GiB, 16 * GiB]) {
      expect(deriveInflightBudgetBytes(limit)).toBeLessThanOrEqual(limit * INFLIGHT_BUDGET_FRACTION);
    }
  });

  // The 640m case is the one that actually bit us: a static 512 MiB default in a
  // 640 MiB container is 80% of everything the process has, for request bodies
  // alone.
  test('a 640 MiB container gets a budget it can survive', () => {
    const budget = deriveInflightBudgetBytes(640 * MiB);
    expect(budget).toBeLessThan(300 * MiB);
    expect(budget).toBeGreaterThan(0);
  });

  test('an unknown limit yields a conservative, non-zero budget', () => {
    const budget = deriveInflightBudgetBytes(null);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(512 * MiB);
  });

  test('a tiny container still gets a usable, non-zero budget', () => {
    // Zero would disable admission control entirely — the opposite of safe.
    expect(deriveInflightBudgetBytes(64 * MiB)).toBeGreaterThan(0);
  });
});

// The Fargate case, which is why this precedence exists at all: the cgroup and
// host both report the microVM, and only the scheduler knows the task limit.
describe('declared task memory wins over any probe', () => {
  test('uses KORTIX_CONTAINER_MEMORY_MIB when the scheduler declares it', () => {
    const limit = detectContainerMemoryLimitBytes({
      read: () => 'max',
      totalMemory: () => 7806 * MiB,
      declaredMiB: () => '4096',
    });
    expect(limit).toBe(4096 * MiB);
  });

  test('a declared limit beats even a readable cgroup value', () => {
    const limit = detectContainerMemoryLimitBytes({
      read: (p) => (p === '/sys/fs/cgroup/memory.max' ? String(7806 * MiB) : null),
      totalMemory: () => 7806 * MiB,
      declaredMiB: () => '4096',
    });
    expect(limit).toBe(4096 * MiB);
  });

  test('garbage or empty declarations fall through to the probes', () => {
    for (const bad of ['', 'not-a-number', '0', '-5', undefined]) {
      const limit = detectContainerMemoryLimitBytes({
        read: () => null,
        totalMemory: () => 2 * GiB,
        declaredMiB: () => bad,
      });
      expect(limit).toBe(2 * GiB);
    }
  });

  test('the real dev numbers now derive 25% of 4096, not of 7806', () => {
    const limit = detectContainerMemoryLimitBytes({
      read: () => 'max',
      totalMemory: () => 7806 * MiB,
      declaredMiB: () => '4096',
    });
    expect(deriveInflightBudgetBytes(limit)).toBe(1024 * MiB);
  });
});
