import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  configureKortix,
  platformConfig,
  isConfigured,
  __setConfigResolver,
  __getConfigResolver,
} from './config';

// This file deliberately never imports `./config-node` (the `@kortix/sdk/server`
// AsyncLocalStorage layer) — it exercises the plain browser/single-config path
// that every host without a registered resolver still gets: `platformConfig()`
// falls back to the process-global `current` set by `configureKortix()`, exactly
// as before the per-request isolation layer existed.
//
// `bun test src` runs every test file in one process, sharing `config.ts`'s
// module state — if some OTHER file in the same run imports `config-node.ts`
// (registering the real AsyncLocalStorage resolver as an import-time side
// effect), that registration is process-global too. Save + restore whatever
// resolver was active before each test here, so this file's "no resolver"
// experiments never permanently clobber another file's registration.
let savedResolver: ReturnType<typeof __getConfigResolver>;
beforeEach(() => {
  savedResolver = __getConfigResolver();
  __setConfigResolver(null);
});
afterEach(() => {
  __setConfigResolver(savedResolver);
});

test('with no resolver registered, platformConfig() reads the process-global set by configureKortix()', () => {
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

test('a registered resolver takes priority over the process-global config', () => {
  configureKortix({ backendUrl: 'http://global.local', getToken: async () => 'global-tok' });
  __setConfigResolver(() => ({ backendUrl: 'http://scoped.local', getToken: async () => 'scoped-tok' }));
  expect(platformConfig().backendUrl).toBe('http://scoped.local');

  __setConfigResolver(() => undefined);
  expect(platformConfig().backendUrl).toBe('http://global.local');
});
