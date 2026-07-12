import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getSandboxPortUrl, getSandboxUrl } from './urls';
import type { SandboxInfo } from './types';

function sandbox(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    sandbox_id: 'db-1',
    external_id: 'ext-1',
    name: 'my-sandbox',
    provider: 'daytona',
    base_url: 'https://fallback.example',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.BACKEND_URL;
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });
});

test('getSandboxUrl builds the proxy url on port 8000 (KORTIX_MASTER) from external_id', () => {
  expect(getSandboxUrl(sandbox({ external_id: 'ext-abc' }))).toBe('http://backend.local/v1/p/ext-abc/8000');
});

test('getSandboxUrl falls back to base_url when external_id is missing', () => {
  const result = getSandboxUrl(sandbox({ external_id: '' as unknown as string, base_url: 'https://direct.example' }));
  expect(result).toBe('https://direct.example');
});

test('getSandboxUrl throws when both external_id and base_url are missing', () => {
  expect(() =>
    getSandboxUrl(sandbox({ external_id: '' as unknown as string, base_url: '' as unknown as string, provider: 'daytona', sandbox_id: 'sbx-9' })),
  ).toThrow(/missing external_id for daytona sandbox "sbx-9"/);
});

test('getSandboxUrl prefers process.env.BACKEND_URL over the configured platform backendUrl', () => {
  process.env.BACKEND_URL = 'http://internal-docker-host:8008/v1';
  expect(getSandboxUrl(sandbox({ external_id: 'ext-1' }))).toBe('http://internal-docker-host:8008/v1/p/ext-1/8000');
});

test('getSandboxUrl falls back to the local-dev default when no backend url is configured at all', () => {
  configureKortix({ backendUrl: '', getToken: async () => 'tok' });
  expect(getSandboxUrl(sandbox({ external_id: 'ext-1' }))).toBe('http://localhost:8008/v1/p/ext-1/8000');
});

test('getSandboxPortUrl builds a url for an arbitrary container port when external_id is present', () => {
  expect(getSandboxPortUrl(sandbox({ external_id: 'ext-1' }), '6080')).toBe('http://backend.local/v1/p/ext-1/6080');
});

test('getSandboxPortUrl returns null (not a broken url) when external_id is missing', () => {
  expect(getSandboxPortUrl(sandbox({ external_id: '' as unknown as string }), '6080')).toBeNull();
});
