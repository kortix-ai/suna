import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectWebUrl, sessionWebUrl, webDashboardUrl } from '../web-url';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.KORTIX_FRONTEND_URL;
  delete process.env.KORTIX_DASHBOARD_URL;
  delete process.env.BASH_ENV;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('webDashboardUrl — derive fallback (no authoritative env)', () => {
  test('prod api host never leaks: api-prod.kortix.com → kortix.com', () => {
    // The original bug: this returned https://api-prod.kortix.com unchanged.
    expect(webDashboardUrl('https://api-prod.kortix.com/v1')).toBe('https://kortix.com');
  });

  test('api. prefix is stripped: api.kortix.com → kortix.com', () => {
    expect(webDashboardUrl('https://api.kortix.com/v1')).toBe('https://kortix.com');
  });

  test('api-<env> maps to subdomain: api-dev.kortix.com → dev.kortix.com', () => {
    expect(webDashboardUrl('https://api-dev.kortix.com')).toBe('https://dev.kortix.com');
  });

  test('<env>-api maps to subdomain: dev-api.kortix.com → dev.kortix.com', () => {
    expect(webDashboardUrl('https://dev-api.kortix.com/v1')).toBe('https://dev.kortix.com');
  });

  test('local self-host: api :8008 → dashboard :3000', () => {
    expect(webDashboardUrl('http://localhost:8008')).toBe('http://localhost:3000');
  });

  test('unparseable input falls back to kortix.com', () => {
    expect(webDashboardUrl('not a url')).toBe('https://kortix.com');
  });
});

describe('webDashboardUrl — authoritative env wins over derivation', () => {
  test('KORTIX_FRONTEND_URL beats the api host', () => {
    process.env.KORTIX_FRONTEND_URL = 'https://kortix.com/';
    expect(webDashboardUrl('https://api-prod.kortix.com/v1')).toBe('https://kortix.com');
  });

  test('KORTIX_DASHBOARD_URL is honored as a legacy override', () => {
    process.env.KORTIX_DASHBOARD_URL = 'http://localhost:3001';
    expect(webDashboardUrl('http://localhost:8008')).toBe('http://localhost:3001');
  });

  test('KORTIX_FRONTEND_URL from agent-env.sh beats API host when shell did not source it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-cli-agent-env-'));
    try {
      const envFile = join(dir, 'agent-env.sh');
      writeFileSync(envFile, "export KORTIX_FRONTEND_URL='https://dev.kortix.com/'\n");
      process.env.BASH_ENV = envFile;

      expect(webDashboardUrl('https://dev-api.kortix.com/v1')).toBe('https://dev.kortix.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('projectWebUrl / sessionWebUrl', () => {
  test('prefers the server-provided dashboard_url', () => {
    expect(
      projectWebUrl('https://api-prod.kortix.com/v1', 'p1', 'https://kortix.com/projects/p1'),
    ).toBe('https://kortix.com/projects/p1');
  });

  test('without dashboard_url, derived host still never leaks api-prod', () => {
    expect(projectWebUrl('https://api-prod.kortix.com/v1', 'p1')).toBe(
      'https://kortix.com/projects/p1',
    );
  });

  test('session url is built on the project url', () => {
    expect(sessionWebUrl('https://api-prod.kortix.com/v1', 'p1', 's1')).toBe(
      'https://kortix.com/projects/p1/sessions/s1',
    );
  });
});
