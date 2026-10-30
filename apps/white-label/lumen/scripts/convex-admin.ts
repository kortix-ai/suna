// A Convex client with the deployment admin key, for operator scripts (seed, eval).
// Local dev: the key and URL come from .convex/ and .env.local. Elsewhere: CONVEX_URL + CONVEX_ADMIN_KEY.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

const APP = join(import.meta.dir, '..');

export function adminClient() {
  let url = process.env.CONVEX_URL;
  let key = process.env.CONVEX_ADMIN_KEY;
  if (!url || !key) {
    const local = JSON.parse(readFileSync(join(APP, '.convex', 'local', 'default', 'config.json'), 'utf8'));
    key ??= local.adminKey as string;
    url ??= readFileSync(join(APP, '.env.local'), 'utf8').match(/^NEXT_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim();
  }
  if (!url || !key) throw new Error('set CONVEX_URL and CONVEX_ADMIN_KEY');
  const client = new ConvexHttpClient(url);
  (client as unknown as { setAdminAuth(k: string): void }).setAdminAuth(key);
  return {
    url,
    query: <T>(name: string, args: Record<string, unknown> = {}) => client.query(makeFunctionReference<'query'>(name), args) as Promise<T>,
    mutation: <T>(name: string, args: Record<string, unknown> = {}) => client.mutation(makeFunctionReference<'mutation'>(name), args) as Promise<T>,
  };
}
