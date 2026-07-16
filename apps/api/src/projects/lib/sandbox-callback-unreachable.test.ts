// sandboxCallbackUnreachableReason() gates session creation/restart/resume on
// KORTIX_URL being publicly reachable — but ONLY for providers whose
// sandboxes actually run remotely. local-docker's containers share the same
// Docker network as kortix-api, so a loopback KORTIX_URL is correct there,
// not an error — see the `requiresPublicCallback` capability on
// platform/providers/index.ts's SandboxProvider interface.
import { describe, expect, test } from 'bun:test';

// config.KORTIX_URL is snapshotted once at module load (see config.ts) — set
// it to a loopback address BEFORE importing, so every test in this file
// observes the same "loopback KORTIX_URL" world and only the provider varies.
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona,local-docker';
process.env.DAYTONA_API_KEY = 'daytona_test_key';
process.env.DAYTONA_SERVER_URL = 'https://app.daytona.io/api';
process.env.DAYTONA_TARGET = 'us';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.KORTIX_URL = 'http://localhost:8008';

const { sandboxCallbackUnreachableReason } = await import('./sessions');

describe('sandboxCallbackUnreachableReason — provider-aware reachability preflight', () => {
  test('a loopback KORTIX_URL blocks a remote-cloud provider (daytona)', () => {
    expect(sandboxCallbackUnreachableReason('daytona')).toMatch(/loopback/i);
  });

  test('the SAME loopback KORTIX_URL is FINE for local-docker (same-machine, Docker-networked)', () => {
    expect(sandboxCallbackUnreachableReason('local-docker')).toBeNull();
  });
});
