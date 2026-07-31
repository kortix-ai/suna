import { expect, test } from 'bun:test';

// config.ts validates the complete process environment during import. Supply
// inert local values so this test covers the schema default without depending
// on a developer's dotenv files or CI secrets.
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.API_KEY_SECRET ??= 'test-api-key-secret';
process.env.KORTIX_URL ??= 'http://127.0.0.1:8008';
process.env.TUNNEL_ENABLED = 'false';
delete process.env.KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK;

const { config } = await import('./config');

test('agent secret-grant switching is allowed when the lock is not explicitly enabled', () => {
  expect(config.KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK).toBe(false);
});
