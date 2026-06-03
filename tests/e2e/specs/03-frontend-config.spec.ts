import { test, expect } from '@playwright/test';

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:13737';
const apiUrl = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';

test.describe('03 — Frontend runtime configuration', () => {
  test('runtime config has correct Supabase URL (not placeholder)', async () => {
    const res = await fetch(`${frontendUrl}/auth`);
    const html = await res.text();

    // Must NOT contain the build-time placeholder
    expect(html).not.toContain('placeholder.supabase.co');

    // Must contain the configured runtime Supabase URL
    expect(html).toContain(supabaseUrl);
  });

  test('runtime config has correct backend URL (not :8008)', async () => {
    const res = await fetch(`${frontendUrl}/auth`);
    const html = await res.text();

    const configMatch = html.match(/__KORTIX_RUNTIME_CONFIG=({[^;]+})/);
    expect(configMatch).toBeTruthy();

    const config = JSON.parse(configMatch![1]);
    expect(config.BACKEND_URL).toBe(apiUrl);
    expect(config.SUPABASE_URL).toBe(supabaseUrl);
  });

  test('runtime config has a real anon key (not placeholder)', async () => {
    const res = await fetch(`${frontendUrl}/auth`);
    const html = await res.text();

    expect(html).not.toContain('local-build-placeholder-anon-key');

    const configMatch = html.match(/__KORTIX_RUNTIME_CONFIG=({[^;]+})/);
    const config = JSON.parse(configMatch![1]);
    expect(config.SUPABASE_ANON_KEY).toMatch(/^eyJ/); // JWT format
  });

  test('no dev Supabase URLs leaked (127.0.0.1:54321)', async () => {
    const res = await fetch(`${frontendUrl}/auth`);
    const html = await res.text();

    expect(html).not.toContain('127.0.0.1:54321');
    expect(html).not.toContain('localhost:54321');
  });
});
