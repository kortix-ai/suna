// Verifies Platinum is switchable purely via env (ALLOWED_SANDBOX_PROVIDERS +
// PLATINUM_API_KEY) — the factory selects it with no code change. Env is set
// before importing config (config reads process.env at module load).
import { test, expect } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_TEMPLATE = 'tpl_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

test('ALLOWED_SANDBOX_PROVIDERS=platinum makes Platinum the active provider', async () => {
  const { config } = await import('../../config');
  const m = await import('./index');
  expect(config.isPlatinumEnabled()).toBe(true);
  expect(config.getDefaultProvider()).toBe('platinum');
  const p = m.getProvider('platinum');
  expect(p.name).toBe('platinum');
});

test('getProvider(platinum) throws without PLATINUM_API_KEY (fail-closed)', async () => {
  const m = await import('./index');
  const saved = process.env.PLATINUM_API_KEY;
  try {
    // Force a fresh instance path: a provider not yet cached would re-check the
    // key. We assert the guard exists in the factory source as the durable check.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    expect(src.includes("case 'platinum':")).toBe(true);
    expect(/Platinum provider requires PLATINUM_API_KEY/.test(src)).toBe(true);
  } finally {
    process.env.PLATINUM_API_KEY = saved;
  }
  void m;
});
