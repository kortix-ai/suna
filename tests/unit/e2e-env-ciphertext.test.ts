import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { optionalEnvValue } from '../e2e/helpers/env';

// `apps/api/.env` is dotenvx ciphertext. #7981 added an encrypted
// SUPABASE_ANON_KEY there, the browser helpers read it as a value, and every
// browser journey on main sent `encrypted:…` as its Supabase apikey.

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-env-'));
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.E2E_ENV_FILE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

it('skips a dotenvx ciphertext and falls through to the next file', () => {
  const encrypted = join(dir, 'encrypted.env');
  const plain = join(dir, 'plain.env');
  writeFileSync(encrypted, 'SUPABASE_ANON_KEY="encrypted:BH9Wbol+ciphertext=="\n');
  writeFileSync(plain, 'SUPABASE_ANON_KEY=plain-anon-key\n');

  expect(optionalEnvValue('SUPABASE_ANON_KEY', encrypted)).toBeUndefined();
  expect(optionalEnvValue('SUPABASE_ANON_KEY', encrypted, plain)).toBe('plain-anon-key');
});
