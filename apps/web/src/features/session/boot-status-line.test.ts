import { expect, test } from 'bun:test';
import { BOOT_STATUS_LABEL } from './boot-status-line';

test('boot status is a single calm line, not a step checklist', () => {
  expect(BOOT_STATUS_LABEL).toBe('Starting your computer…');
  // Guard against regressing to the 4-step theater copy.
  expect(BOOT_STATUS_LABEL).not.toContain('Allocating');
  expect(BOOT_STATUS_LABEL).not.toContain('Provisioning your computer');
});
