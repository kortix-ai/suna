import { test, expect } from 'bun:test';
import {
  configureKortix,
  platformConfig,
  isConfigured,
} from './config';
import { runWithKortix } from '../../platform/config-node';

// `bun test src` runs SDK test files in one process. Do not mutate the internal
// config resolver here: `@kortix/sdk/server` installs the real AsyncLocalStorage
// resolver as a process-global import-time side effect, and clearing it from
// this file can race other async tests. These assertions exercise the fallback
// and scoped paths through the public-ish Node helper instead.

test('with no active scoped config, platformConfig() reads the process-global set by configureKortix()', () => {
  configureKortix({ backendUrl: 'http://global.local', getToken: async () => 'global-tok' });
  expect(platformConfig().backendUrl).toBe('http://global.local');
  expect(isConfigured()).toBe(true);
});

test('configureKortix(config, { global: false }) does not touch the process-global config', () => {
  configureKortix({ backendUrl: 'http://one.local', getToken: async () => 'one' });
  configureKortix({ backendUrl: 'http://two.local', getToken: async () => 'two' }, { global: false });
  // The second call was global:false — the global config must still be the first one.
  expect(platformConfig().backendUrl).toBe('http://one.local');
});

test('an active scoped resolver takes priority over the process-global config', async () => {
  configureKortix({ backendUrl: 'http://global.local', getToken: async () => 'global-tok' });
  await runWithKortix(
    { backendUrl: 'http://scoped.local', getToken: async () => 'scoped-tok' },
    async () => {
      expect(platformConfig().backendUrl).toBe('http://scoped.local');
    },
  );

  expect(platformConfig().backendUrl).toBe('http://global.local');
});
