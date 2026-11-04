import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { config } from '../config';
import * as auditScope from '../shared/audit-scope';
import { kickStartupPreBuild } from './builder';

const enabled = config.KORTIX_WORKERS_ENABLED;
const skipped = process.env.KORTIX_SKIP_STARTUP_PREBUILD;
const tick = spyOn(auditScope, 'runWorkerTick').mockImplementation(async () => { throw new Error('Unexpected startup snapshot work'); });
afterAll(() => tick.mockRestore());
afterEach(() => {
  config.KORTIX_WORKERS_ENABLED = enabled;
  if (skipped === undefined) delete process.env.KORTIX_SKIP_STARTUP_PREBUILD;
  else process.env.KORTIX_SKIP_STARTUP_PREBUILD = skipped;
  tick.mockClear();
});

test('disabled workers prevent startup snapshot work even when the dedicated skip flag is false', () => {
  config.KORTIX_WORKERS_ENABLED = false;
  process.env.KORTIX_SKIP_STARTUP_PREBUILD = 'false';
  kickStartupPreBuild();
  expect(tick).not.toHaveBeenCalled();
});

test('the dedicated snapshot skip remains effective when workers are enabled', () => {
  config.KORTIX_WORKERS_ENABLED = true;
  process.env.KORTIX_SKIP_STARTUP_PREBUILD = 'true';
  kickStartupPreBuild();
  expect(tick).not.toHaveBeenCalled();
});
