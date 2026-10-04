import { afterEach, describe, expect, test } from 'bun:test';

import { supabaseEnv } from './env';

/**
 * Pins the runtime-env precedence of the one Supabase env chain
 * (`lib/supabase/env.ts`): runtime vars must beat the NEXT_PUBLIC_ values,
 * which Next.js inlines at build time and which carry placeholder values
 * inside Docker containers.
 */

const env = process.env as Record<string, string | undefined>;

const CHAIN_VARS = [
  'SUPABASE_SERVER_URL',
  'SUPABASE_URL',
  'KORTIX_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'KORTIX_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;

const originals = new Map(CHAIN_VARS.map((name) => [name, env[name]]));

afterEach(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

describe('supabaseEnv', () => {
  test('runtime vars win over NEXT_PUBLIC_ build-time placeholders', () => {
    env.SUPABASE_URL = 'https://runtime.example.com';
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.example.com';
    env.SUPABASE_ANON_KEY = 'runtime-anon-key';
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'placeholder-anon-key';

    const { url, anonKey } = supabaseEnv();

    expect(url).toBe('https://runtime.example.com');
    expect(anonKey).toBe('runtime-anon-key');
  });

  test('the internal Docker network URL wins for server-side calls', () => {
    env.SUPABASE_SERVER_URL = 'http://supabase-kong:8000';
    env.SUPABASE_URL = 'https://public.example.com';

    expect(supabaseEnv().url).toBe('http://supabase-kong:8000');
  });

  test('falls back through KORTIX_PUBLIC_ and NEXT_PUBLIC_', () => {
    env.KORTIX_PUBLIC_SUPABASE_URL = 'https://kortix-public.example.com';
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'next-public-anon-key';

    const { url, anonKey } = supabaseEnv();

    expect(url).toBe('https://kortix-public.example.com');
    expect(anonKey).toBe('next-public-anon-key');
  });
});
