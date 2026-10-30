import { createClient } from '@supabase/supabase-js';
import { expect, test } from 'bun:test';
import { removeProfileAvatar } from './profile-avatar';

test('removal deletes every owned avatar before clearing metadata', async () => {
  const calls: string[] = [];
  const client = createClient('https://storage.example.test', 'synthetic-key', {
    auth: { persistSession: false },
    global: {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(String(input));
          calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
          if (url.pathname.endsWith('/list/avatars'))
            return Response.json(
              calls.length === 1 ? [{ name: 'old.png' }, { name: 'older.png' }] : [],
            );
          if (url.pathname === '/storage/v1/object/avatars') {
            expect(JSON.parse(String(init?.body)).prefixes).toEqual([
              'synthetic-user/old.png',
              'synthetic-user/older.png',
            ]);
            return Response.json([]);
          }
          return Response.json({ id: 'synthetic-user' });
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });
  await removeProfileAvatar(
    {
      storage: client.storage,
      auth: {
        updateUser: async () => {
          calls.push('PUT /auth/v1/user');
          return { error: null };
        },
      },
    },
    'synthetic-user',
  );
  expect(calls).toEqual([
    'POST /storage/v1/object/list/avatars',
    'DELETE /storage/v1/object/avatars',
    'POST /storage/v1/object/list/avatars',
    'PUT /auth/v1/user',
  ]);
});

test('storage failure does not clear metadata', async () => {
  const calls: string[] = [];
  const client = createClient('https://storage.example.test', 'synthetic-key', {
    auth: { persistSession: false },
    global: {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          calls.push(new URL(String(input)).pathname);
          return Response.json({ message: 'storage unavailable' }, { status: 503 });
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });
  await expect(
    removeProfileAvatar(
      {
        storage: client.storage,
        auth: {
          updateUser: async () => {
            calls.push('/auth/v1/user');
            return { error: null };
          },
        },
      },
      'synthetic-user',
    ),
  ).rejects.toThrow();
  expect(calls.every((path) => path === '/storage/v1/object/list/avatars')).toBe(true);
});
