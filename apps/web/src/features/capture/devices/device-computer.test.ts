import { describe, expect, test } from 'bun:test';

import { computerForDevice } from './device-status';

const MACHINE = 'a'.repeat(64);
const computers = [
  { tunnelId: 't1', name: 'Studio', machineInfo: { machineId: 'b'.repeat(64) } },
  { tunnelId: 't2', name: 'Laptop', machineInfo: { machineId: MACHINE, hostname: 'laptop.local' } },
];

describe('computerForDevice', () => {
  test('a device joins the computer with the same machine id', () => {
    expect(computerForDevice({ machine_id: MACHINE }, computers)?.tunnelId).toBe('t2');
  });
  test('no machine id, no match, or no computers: none (the device keeps its own name)', () => {
    expect(computerForDevice({ machine_id: null }, computers)).toBeNull();
    expect(computerForDevice({ machine_id: 'c'.repeat(64) }, computers)).toBeNull();
    expect(computerForDevice({ machine_id: MACHINE }, undefined)).toBeNull();
  });
});
