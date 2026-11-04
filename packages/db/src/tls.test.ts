import { describe, expect, test } from 'bun:test';
import { requiresTls } from './tls';

describe('requiresTls', () => {
  test('Supabase direct and pooler hosts require TLS', () => {
    expect(requiresTls('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres')).toBe(true);
    expect(requiresTls('postgresql://u:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres')).toBe(true);
  });

  test('an explicit sslmode in the URL wins', () => {
    expect(requiresTls('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=disable')).toBe(false);
  });

  test('local and self-hosted databases are unchanged', () => {
    expect(requiresTls('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(false);
    expect(requiresTls('postgresql://postgres:postgres@postgres:5432/kortix')).toBe(false);
    expect(requiresTls('not a url')).toBe(false);
  });
});
