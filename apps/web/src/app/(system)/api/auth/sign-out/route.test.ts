import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { AUTH_BOUNCE_COOKIE } from '@/lib/onboarding/landing-destination';
import { MAINTENANCE_BYPASS_COOKIE } from '@/lib/maintenance-bypass';

const removed: string[] = [];
mock.module('next/headers', () => ({ cookies: async () => ({ delete: (name: string) => removed.push(name) }) }));
mock.module('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
const { POST } = await import('./route');

test('cross-origin and originless requests cannot clear sign-out cookies', async () => {
  for (const origin of [undefined, 'https://foreign.example']) {
    const headers = new Headers({ host: 'localhost:13000' });
    if (origin) headers.set('origin', origin);
    const response = await POST(new NextRequest('http://localhost:13000/api/auth/sign-out', { method: 'POST', headers }));
    expect(response.status).toBe(403);
  }
  expect(removed).toEqual([]);
});

test('a deleted session still clears both httpOnly cookies', async () => {
  const response = await POST(new NextRequest('http://localhost:13000/api/auth/sign-out', {
    method: 'POST', headers: { host: 'localhost:13000', origin: 'http://localhost:13000' },
  }));
  expect(response.status).toBe(204);
  expect(removed).toEqual([AUTH_BOUNCE_COOKIE, MAINTENANCE_BYPASS_COOKIE]);
});
