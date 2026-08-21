import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const { currentProjectImageDataPlaneScope, projectImageRolloutDiagnostic } =
  await import('./project-image-scope');
const { dataPlaneScopeFromSupabaseUrl } = await import('./ppwarm-names');

describe('currentProjectImageDataPlaneScope', () => {
  test('uses the public endpoint when one is configured', () => {
    expect(
      currentProjectImageDataPlaneScope({
        SUPABASE_URL: 'http://supabase-kong:8000',
        SUPABASE_PUBLIC_URL: 'https://dev-data.example.test',
        INTERNAL_KORTIX_ENV: 'dev',
      }),
    ).toBe(dataPlaneScopeFromSupabaseUrl('https://dev-data.example.test', 'dev'));
  });

  test('falls back to the internal endpoint and always includes the environment', () => {
    const settings = {
      SUPABASE_URL: 'http://supabase-kong:8000',
      SUPABASE_PUBLIC_URL: '',
      INTERNAL_KORTIX_ENV: 'dev' as const,
    };
    expect(currentProjectImageDataPlaneScope(settings)).toBe(
      dataPlaneScopeFromSupabaseUrl(settings.SUPABASE_URL, 'dev'),
    );
    expect(currentProjectImageDataPlaneScope(settings)).not.toBe(
      currentProjectImageDataPlaneScope({ ...settings, INTERNAL_KORTIX_ENV: 'staging' }),
    );
  });

  test('normalizes preview to dev because preview shares the dev data plane', () => {
    const settings = {
      SUPABASE_URL: 'https://dev-data.example.test',
      SUPABASE_PUBLIC_URL: '',
      INTERNAL_KORTIX_ENV: 'dev' as const,
    };
    expect(currentProjectImageDataPlaneScope(settings)).toBe(
      currentProjectImageDataPlaneScope({ ...settings, INTERNAL_KORTIX_ENV: 'preview' }),
    );
  });
});

describe('projectImageRolloutDiagnostic', () => {
  test('exposes one non-secret scope and the exact format version', () => {
    const settings = {
      SUPABASE_URL: 'https://internal.example.test',
      SUPABASE_PUBLIC_URL: 'https://public.example.test',
      INTERNAL_KORTIX_ENV: 'dev' as const,
      KORTIX_FAST_COLD_BOOT_CONFIGURED: true,
      KORTIX_FAST_COLD_BOOT_ENABLED: false,
    };
    expect(projectImageRolloutDiagnostic(settings)).toEqual({
      fastConfigured: true,
      fastEnabled: false,
      projectImageScope: currentProjectImageDataPlaneScope(settings),
      formatVersion: 'kpp2',
    });
  });
});
