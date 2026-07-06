import { test, expect, beforeEach, afterEach } from 'bun:test';
import { configureKortix } from '../../platform/config';
import { setCurrentRuntime } from '../current-runtime';

// This file must be hermetic against `mock.module(...)` registrations OTHER
// files make for this exact module (`state/server-store/active`) — Bun's
// `mock.module` is process-wide and permanent for the whole `bun test` sweep,
// and (confirmed empirically) it collides bidirectionally through the
// `export { getActiveOpenCodeUrl, ... } from './server-store/active'`
// re-export chain in `../server-store.ts`: mocking EITHER the barrel
// (`../server-store`, as `files/client.test.ts` used to) OR this submodule
// directly (as `opencode/client.test.ts` used to) replaced this module's real
// exports for every other importer too, including a plain static
// `import ... from './active'` here (which would crash with "Export named
// '...' not found" once some export the mock omitted got statically linked).
// Both of those files were fixed to drive their test scenarios through the
// REAL `current-runtime`/`config` seams instead (see their own comments) —
// this file additionally imports dynamically via `await import(...)` as a
// second layer of defense against any future file re-introducing that
// pattern.
const {
  deriveSubdomainOpts,
  getActiveDbSandboxId,
  getActiveOpenCodeUrl,
  getActiveSandboxId,
  getBackendPort,
} = await import('./active');

// Both `platformConfig()` (process-global `current`) and the current-runtime
// pointer are module-level singletons — reset both around every test so this
// file's experiments never leak into (or get leaked into by) another test file
// sharing the same `bun test` process.
beforeEach(() => {
  setCurrentRuntime(null);
});
afterEach(() => {
  setCurrentRuntime(null);
});

test('getActiveOpenCodeUrl prefers the current-runtime url when a session is active', () => {
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok', billingEnabled: false });
  setCurrentRuntime('http://backend.local/v1/p/sb-1/8000', 'sb-1');

  expect(getActiveOpenCodeUrl()).toBe('http://backend.local/v1/p/sb-1/8000');
});

test('getActiveOpenCodeUrl falls back to the default sandbox url in self-hosted local dev (no billing, no active session)', () => {
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => 'tok',
    billingEnabled: false,
    sandboxId: 'local-sbx',
  });

  expect(getActiveOpenCodeUrl()).toBe('http://backend.local/v1/p/local-sbx/8000');
});

test('getActiveOpenCodeUrl returns empty string in a billing-enabled deployment with no active session', () => {
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => 'tok',
    billingEnabled: true,
    sandboxId: 'should-be-ignored',
  });

  expect(getActiveOpenCodeUrl()).toBe('');
});

test('getActiveOpenCodeUrl treats an unset billingEnabled as false (defaults to the self-hosted fallback)', () => {
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok', sandboxId: 'sbx-1' });

  expect(getActiveOpenCodeUrl()).toBe('http://backend.local/v1/p/sbx-1/8000');
});

test('getActiveSandboxId prefers the current-runtime sandbox id over the configured default', () => {
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok', sandboxId: 'configured-default' });
  setCurrentRuntime('http://backend.local/v1/p/sb-active/8000', 'sb-active');

  expect(getActiveSandboxId()).toBe('sb-active');
});

test('getActiveSandboxId falls back to the configured default sandbox id with no active session', () => {
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok', sandboxId: 'configured-default' });

  expect(getActiveSandboxId()).toBe('configured-default');
});

test('getActiveSandboxId returns undefined with neither an active session nor a configured default', () => {
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });

  expect(getActiveSandboxId()).toBeUndefined();
});

test('getActiveDbSandboxId returns the current-runtime db sandbox id while a session is active', () => {
  setCurrentRuntime('http://backend.local/v1/p/sb-1/8000', 'sb-1', 'db-sbx-1');

  expect(getActiveDbSandboxId()).toBe('db-sbx-1');
});

test('getActiveDbSandboxId returns undefined with no active session runtime', () => {
  expect(getActiveDbSandboxId()).toBeUndefined();
});

test('getBackendPort extracts the numeric port from the configured backend url', () => {
  configureKortix({ backendUrl: 'http://localhost:8008/v1', getToken: async () => 'tok' });

  expect(getBackendPort()).toBe(8008);
});

test('getBackendPort defaults to 443 for an https url with no explicit port', () => {
  configureKortix({ backendUrl: 'https://api.kortix.example/v1', getToken: async () => 'tok' });

  expect(getBackendPort()).toBe(443);
});

test('getBackendPort defaults to 80 for an http url with no explicit port', () => {
  configureKortix({ backendUrl: 'http://api.kortix.example/v1', getToken: async () => 'tok' });

  expect(getBackendPort()).toBe(80);
});

test('getBackendPort falls back to 8008 when the configured backend url fails to parse', () => {
  configureKortix({ backendUrl: 'not a url', getToken: async () => 'tok' });

  expect(getBackendPort()).toBe(8008);
});

test('deriveSubdomainOpts always returns a fully-populated options object', () => {
  configureKortix({ backendUrl: 'http://localhost:8008/v1', getToken: async () => 'tok' });
  setCurrentRuntime('http://localhost:8008/v1/p/sb-1/8000', 'sb-1');

  expect(deriveSubdomainOpts()).toEqual({
    sandboxId: 'sb-1',
    backendPort: 8008,
    apiBaseUrl: 'http://localhost:8008/v1',
  });
});

test('deriveSubdomainOpts uses an empty-string sandboxId (never undefined) when none is resolvable', () => {
  configureKortix({ backendUrl: 'http://localhost:8008/v1', getToken: async () => 'tok' });

  expect(deriveSubdomainOpts().sandboxId).toBe('');
});
