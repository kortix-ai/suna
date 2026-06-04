import { test, expect } from '@playwright/test';
import { optionalEnvValue } from '../helpers/env';

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:13737';
const apiUrl = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';

test.describe('02 — Services respond on correct ports', () => {
  test('Frontend responds on :13737', async () => {
    const res = await fetch(`${frontendUrl}/auth`);
    expect(res.status).toBe(200);
  });

  test('API health check passes on :13738', async () => {
    const res = await fetch(`${apiUrl}/health`);
    expect(res.status).toBe(200);
  });

  test('Supabase Auth health passes on :13740', async () => {
    const anonKey = optionalEnvValue('SUPABASE_ANON_KEY', `${process.env.HOME}/.kortix/.env`);
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      headers: anonKey ? { apikey: anonKey } : {},
    });
    expect(res.status).toBe(200);
  });

  test('API install-status endpoint works', async () => {
    const res = await fetch(`${apiUrl}/setup/install-status`);
    expect(res.status).toBe(200);
  });
});
