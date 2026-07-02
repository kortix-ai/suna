import { beforeEach, describe, expect, test } from 'bun:test';

// disk-quota-guard.ts takes its Daytona list/archive functions purely via an
// injected `deps` object (no runtime import from ../shared/daytona), so this
// file needs no module mocking at all — which matters here specifically:
// shared/daytona.test.ts unit-tests that real module directly, and bun's
// mock.module() is a process-wide registry (confirmed: it is NOT scoped per
// test file despite bunfig.toml's `isolation = true`), so a mock.module call
// in this file would silently hijack the module the OTHER file is testing.
const {
  runDiskArchiveSweep,
  triggerEmergencyDiskArchiveSweep,
  __resetDiskQuotaGuardStateForTests,
} = await import('./disk-quota-guard');

function sandboxes(spec: Array<[string, number]>) {
  return spec.map(([id, disk]) => ({ id, disk, lastActivityAt: null }));
}

describe('runDiskArchiveSweep', () => {
  test('archives every stopped sandbox the list returns, not just enough to hit a buffer', async () => {
    const all = sandboxes(Array.from({ length: 1000 }, (_, i) => [`sb-${i}`, 20]));
    const archived: string[] = [];
    const result = await runDiskArchiveSweep({
      list: async () => all,
      archive: async (id) => {
        archived.push(id);
        return true;
      },
    });
    expect(result.candidates).toBe(1000);
    expect(result.archived).toBe(1000);
    expect(result.freedGib).toBe(20000);
    expect(archived.length).toBe(1000);
  });

  test('archives a small pool in full too', async () => {
    const all = sandboxes([
      ['a', 10],
      ['b', 10],
      ['c', 10],
    ]);
    const result = await runDiskArchiveSweep({
      list: async () => all,
      archive: async () => true,
    });
    expect(result.candidates).toBe(3);
    expect(result.archived).toBe(3);
    expect(result.freedGib).toBe(30);
  });

  test('counts archive failures separately and only sums freed disk for successes', async () => {
    const all = sandboxes([
      ['a', 20],
      ['b', 20],
      ['c', 20],
    ]);
    const result = await runDiskArchiveSweep({
      list: async () => all,
      archive: async (id) => id !== 'b', // 'b' fails (e.g. unarchivable class)
    });
    expect(result.candidates).toBe(3);
    expect(result.archived).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.freedGib).toBe(40);
  });

  test('no-ops cleanly when there are no stopped sandboxes', async () => {
    const result = await runDiskArchiveSweep({
      list: async () => [],
      archive: async () => true,
    });
    expect(result).toEqual({ candidates: 0, archived: 0, errors: 0, freedGib: 0 });
  });
});

describe('triggerEmergencyDiskArchiveSweep', () => {
  beforeEach(() => {
    __resetDiskQuotaGuardStateForTests();
  });

  test('runs exactly one sweep for a burst of concurrent triggers (single-flight)', async () => {
    let listCalls = 0;
    const deps = {
      list: async () => {
        listCalls += 1;
        return sandboxes([['a', 10]]);
      },
      archive: async () => true,
    };
    const p1 = triggerEmergencyDiskArchiveSweep('create', deps);
    const p2 = triggerEmergencyDiskArchiveSweep('resume', deps);
    const p3 = triggerEmergencyDiskArchiveSweep('create-warm', deps);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    await p1;
    expect(listCalls).toBe(1);
  });

  test('a second trigger right after completion is cooldown-gated (returns null)', async () => {
    const deps = { list: async () => sandboxes([['a', 10]]), archive: async () => true };
    await triggerEmergencyDiskArchiveSweep('create', deps);
    const second = triggerEmergencyDiskArchiveSweep('create', deps);
    expect(second).toBeNull();
  });

  test('resetting test state clears the cooldown so a new sweep can run', async () => {
    const deps = { list: async () => sandboxes([['a', 10]]), archive: async () => true };
    await triggerEmergencyDiskArchiveSweep('create', deps);
    __resetDiskQuotaGuardStateForTests();
    const result = triggerEmergencyDiskArchiveSweep('create', deps);
    expect(result).not.toBeNull();
    await result;
  });
});
