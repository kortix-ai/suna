import { expect, test } from 'bun:test';
import { DEFAULT_SANDBOX_MOUNT_LIMIT } from './access';
import { mountSlotsFrom } from './volumes';

test('node share on plans the total cap; off, or an older Platinum, plans the private one', () => {
  expect(mountSlotsFrom({ max_mounts_per_sandbox: 8, max_total_mounts_per_sandbox: 64, node_share: true })).toBe(64);
  expect(mountSlotsFrom({ max_mounts_per_sandbox: 8, max_total_mounts_per_sandbox: 64, node_share: false })).toBe(8);
  expect(mountSlotsFrom({ max_mounts_per_sandbox: 8, node_share: true })).toBe(8);
  expect(mountSlotsFrom({})).toBe(DEFAULT_SANDBOX_MOUNT_LIMIT);
});
