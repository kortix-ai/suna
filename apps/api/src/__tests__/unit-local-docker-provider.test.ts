import { afterEach, describe, expect, test } from 'bun:test';

const originalHost = process.env.KORTIX_LOCAL_DOCKER_HOST;

process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/postgres';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.API_KEY_SECRET ??= 'test-api-key-secret';
process.env.TUNNEL_SIGNING_SECRET ??= 'test-tunnel-signing-secret';
process.env.ALLOWED_SANDBOX_PROVIDERS = 'local_docker';

const { localDockerBaseUrlForPort } = await import('../platform/providers/local-docker');

afterEach(() => {
  if (originalHost === undefined) {
    delete process.env.KORTIX_LOCAL_DOCKER_HOST;
  } else {
    process.env.KORTIX_LOCAL_DOCKER_HOST = originalHost;
  }
});

describe('local docker provider URLs', () => {
  test('defaults published sandbox ports to localhost for host-run API', () => {
    delete process.env.KORTIX_LOCAL_DOCKER_HOST;
    expect(localDockerBaseUrlForPort(55001)).toBe('http://127.0.0.1:55001');
  });

  test('uses a Docker host gateway name when API runs inside compose', () => {
    process.env.KORTIX_LOCAL_DOCKER_HOST = 'host.docker.internal';
    expect(localDockerBaseUrlForPort(55001)).toBe('http://host.docker.internal:55001');
  });
});
