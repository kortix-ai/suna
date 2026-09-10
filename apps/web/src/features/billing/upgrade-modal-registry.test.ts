import { beforeEach, describe, expect, test } from 'bun:test';
import { claimUpgradeModal, upgradeModalClaimCount } from './upgrade-modal-registry';

describe('upgrade modal single-instance registry', () => {
  const releases: Array<() => void> = [];

  beforeEach(() => {
    while (releases.length) releases.pop()!();
  });

  function claim(name: string, seen: Record<string, boolean[]>) {
    const token = {};
    seen[name] = [];
    const release = claimUpgradeModal(token, (owner) => seen[name]!.push(owner));
    releases.push(release);
    return release;
  }

  test('one claimant draws', () => {
    const seen: Record<string, boolean[]> = {};
    claim('a', seen);
    expect(seen.a!.at(-1)).toBe(true);
    expect(upgradeModalClaimCount()).toBe(1);
  });

  test('a second claimant never draws while the first is mounted', () => {
    // The prod shape: `/new` mounts one renderer and the account hub's Plan
    // pane mounts another. Two open Radix dialogs mark each other aria-hidden
    // and the accessibility tree ends up with neither.
    const seen: Record<string, boolean[]> = {};
    claim('a', seen);
    claim('b', seen);
    expect(seen.a!.at(-1)).toBe(true);
    expect(seen.b!.at(-1)).toBe(false);
  });

  test('the next claimant is promoted when the owner unmounts', () => {
    const seen: Record<string, boolean[]> = {};
    const releaseA = claim('a', seen);
    claim('b', seen);
    releaseA();
    expect(seen.b!.at(-1)).toBe(true);
  });

  test('releasing a non-owner leaves the owner alone', () => {
    const seen: Record<string, boolean[]> = {};
    claim('a', seen);
    const releaseB = claim('b', seen);
    releaseB();
    expect(seen.a!.at(-1)).toBe(true);
    expect(upgradeModalClaimCount()).toBe(1);
  });

  test('releasing twice is harmless', () => {
    const seen: Record<string, boolean[]> = {};
    const releaseA = claim('a', seen);
    claim('b', seen);
    releaseA();
    releaseA();
    expect(seen.b!.at(-1)).toBe(true);
    expect(upgradeModalClaimCount()).toBe(1);
  });
});
