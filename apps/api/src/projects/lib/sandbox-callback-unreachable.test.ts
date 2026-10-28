// sandboxCallbackUnreachableReason() gates session creation/restart/resume on
// KORTIX_URL being publicly reachable by the supported remote providers.
import { describe, expect, test } from 'bun:test';

// config.KORTIX_URL is snapshotted once at module load (see config.ts) — set
// it to a loopback address BEFORE importing, so every test in this file
// observes the same "loopback KORTIX_URL" world and only the provider varies.
process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY ??= 'pt_test_key';
process.env.PLATINUM_API_URL ??= 'https://api.platinum.test';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.KORTIX_URL = 'http://localhost:8008';

const { sandboxCallbackUnreachableReason } = await import('./sessions');

describe('sandboxCallbackUnreachableReason — reachability preflight', () => {
  test('a loopback KORTIX_URL blocks a remote-cloud provider (platinum)', () => {
    expect(sandboxCallbackUnreachableReason()).toMatch(/loopback/i);
  });
});
