import { test, expect, beforeEach, describe } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  APP_VIEWER_HEADER,
  APP_VIEWER_TOKEN_HEADER,
  AppViewerUnavailableError,
  createAppViewerKortix,
  readAppViewer,
} from './app-viewer';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

/** Byte-for-byte what the Kortix gate emits (apps/api/src/apps/viewer.ts). */
function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret)
    .update('kortix-app-viewer:v1\0')
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  appId: 'app-1',
  userId: 'user-1',
  email: 'viewer@example.test',
  groupIds: ['group-1'],
  accountId: 'acct-1',
  accessMode: 'restricted',
  iat: now(),
  exp: now() + 300,
  ...over,
});

const req = (headers: Record<string, string>) => new Request('https://app.example/', { headers });

beforeEach(() => {
  delete (globalThis as any).process.env.KORTIX_APP_VIEWER_SECRET;
});

describe('readAppViewer', () => {
  test('returns the viewer the gate signed', async () => {
    const viewer = await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload()) }), { secret: SECRET });
    expect(viewer).toMatchObject({
      userId: 'user-1',
      email: 'viewer@example.test',
      groupIds: ['group-1'],
      accountId: 'acct-1',
      appId: 'app-1',
      accessMode: 'restricted',
      token: null,
    });
    expect(viewer!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('carries the App-scoped token when the gate sent one', async () => {
    const viewer = await readAppViewer(
      req({ [APP_VIEWER_HEADER]: sign(payload()), [APP_VIEWER_TOKEN_HEADER]: 'kortix_oat_x' }),
      { secret: SECRET },
    );
    expect(viewer!.token).toBe('kortix_oat_x');
  });

  test('reads the secret from the environment Kortix injects', async () => {
    (globalThis as any).process.env.KORTIX_APP_VIEWER_SECRET = SECRET;
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload()) }))).not.toBeNull();
  });

  test('an unverifiable identity is NEVER trusted', async () => {
    const good = sign(payload());
    // no secret configured at all
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: good }))).toBeNull();
    // signed by another App
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload(), OTHER_SECRET) }), { secret: SECRET })).toBeNull();
    // payload swapped under a valid signature
    const [, sig] = good.split('.');
    const forgedBody = Buffer.from(JSON.stringify(payload({ userId: 'attacker' })), 'utf8').toString('base64url');
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: `${forgedBody}.${sig}` }), { secret: SECRET })).toBeNull();
    // expired
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload({ exp: now() - 1 })) }), { secret: SECRET })).toBeNull();
    // signed by the right key, but not a statement about a person: refused, and
    // never coerced into a viewer with fields quietly missing
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign({ v: 1, hello: 'world' }) }), { secret: SECRET })).toBeNull();
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload({ userId: '' })) }), { secret: SECRET })).toBeNull();
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload({ groupIds: 'finance' })) }), { secret: SECRET })).toBeNull();
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload({ groupIds: [1, 2] })) }), { secret: SECRET })).toBeNull();
    expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(payload({ email: 42 })) }), { secret: SECRET })).toBeNull();
    // an absent groupIds is tolerated — the gate always sends one, and an empty
    // list is the truthful reading of "no groups stated"
    const noGroups = payload();
    delete (noGroups as Record<string, unknown>).groupIds;
    expect((await readAppViewer(req({ [APP_VIEWER_HEADER]: sign(noGroups) }), { secret: SECRET }))!.groupIds).toEqual([]);
    // shapes
    for (const bad of ['', 'nodot', 'a.b.c']) {
      expect(await readAppViewer(req({ [APP_VIEWER_HEADER]: bad }), { secret: SECRET })).toBeNull();
    }
    // absent
    expect(await readAppViewer(req({}), { secret: SECRET })).toBeNull();
  });
});

describe('createAppViewerKortix', () => {
  test('acts as the viewer with their App-scoped token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
      return Response.json([{ project_id: 'p-1' }]);
    }) as typeof fetch;
    const kortix = await createAppViewerKortix(
      req({ [APP_VIEWER_HEADER]: sign(payload()), [APP_VIEWER_TOKEN_HEADER]: 'kortix_oat_api' }),
      { backendUrl: 'https://api.kortix.test/v1', secret: SECRET },
    );
    await kortix.projects.list();
    expect(calls.at(-1)).toMatchObject({ auth: 'Bearer kortix_oat_api' });
    expect(calls.at(-1)!.url).toContain('https://api.kortix.test/v1');
  });

  test('fails loudly rather than acting as nobody', async () => {
    const noViewer = await createAppViewerKortix(req({}), {
      backendUrl: 'https://api.kortix.test/v1',
      secret: SECRET,
    }).catch((e) => e);
    expect(noViewer).toBeInstanceOf(AppViewerUnavailableError);
    expect(noViewer.code).toBe('no_viewer');

    const identityOnly = await createAppViewerKortix(
      req({ [APP_VIEWER_HEADER]: sign(payload()) }),
      { backendUrl: 'https://api.kortix.test/v1', secret: SECRET },
    ).catch((e) => e);
    expect(identityOnly).toBeInstanceOf(AppViewerUnavailableError);
    expect(identityOnly.code).toBe('identity_only');
  });
});
