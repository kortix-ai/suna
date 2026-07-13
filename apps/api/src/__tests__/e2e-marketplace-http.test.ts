import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let authCalls = 0;

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: () => Promise<void>) => {
    authCalls += 1;
    c.set('user', {
      id: '00000000-0000-4000-a000-000000000001',
      email: 'marketplace-http@example.test',
    });
    await next();
  },
}));

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

describe('marketplace HTTP contract', () => {
  beforeAll(async () => {
    process.env.KORTIX_DEFAULT_MARKETPLACES = '';
    process.env.KORTIX_MARKETPLACE_REGISTRIES = '';
    const { marketplaceApp } = await import('../marketplace');
    const app = new Hono();
    app.route('/v1/marketplace', marketplaceApp);
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://${server.hostname}:${server.port}/v1`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test('GET /marketplace/items returns only kortix-* skills as Kortix-managed', async () => {
    const res = await fetch(`${baseUrl}/marketplace/items?source=kortix`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ name: string; managedBy?: string; updatePolicy?: string; categories: string[] }> };

    const managed = body.items
      .filter((item) => item.managedBy === 'kortix')
      .map((item) => item.name)
      .sort();

    expect(managed).toEqual([
      'kortix-computer',
      'kortix-executor',
      'kortix-memory',
      'kortix-slack',
      'kortix-system',
    ]);
    for (const name of managed) {
      const item = body.items.find((candidate) => candidate.name === name)!;
      expect(item.updatePolicy).toBe('kortix-managed');
      expect(item.categories).toContain('kortix-managed');
    }

    expect(body.items.find((item) => item.name === 'agent-browser')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'pty')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'web_search')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'pdf')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'kortix')).toMatchObject({
      name: 'kortix',
      type: 'registry:agent',
    });
    expect(body.items.find((item) => item.name === 'kortix')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'memory-reflector')).toMatchObject({
      name: 'memory-reflector',
      type: 'registry:agent',
    });
  });

  test('GET /marketplace/items is public read-only', async () => {
    authCalls = 0;
    const res = await fetch(`${baseUrl}/marketplace/items?query=agent-browser&source=kortix`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ name: string; type: string }> };
    expect(body.items).toContainEqual(expect.objectContaining({ name: 'agent-browser', type: 'registry:skill' }));
    expect(authCalls).toBe(0);
  });

  test('GET /marketplace/sources still requires auth middleware', async () => {
    authCalls = 0;
    const res = await fetch(`${baseUrl}/marketplace/sources`);
    // The test auth middleware accepts when it runs; this pins that source
    // management still passes through auth instead of staying public.
    expect(res.status).not.toBe(404);
    expect(authCalls).toBeGreaterThan(0);
  });

  test('GET /marketplace/items/:id exposes managed metadata on detail', async () => {
    const list = await fetch(`${baseUrl}/marketplace/items?query=kortix-system&source=kortix`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    const listed = await list.json() as { items: Array<{ id: string; name: string }> };
    const id = listed.items.find((item) => item.name === 'kortix-system')?.id;
    expect(id).toBeTruthy();

    const detail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent(id!)}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      name: string;
      managedBy?: string;
      updatePolicy?: string;
      files: Array<{ target: string; type: string }>;
      readme: string | null;
    };

    expect(body.name).toBe('kortix-system');
    expect(body.managedBy).toBe('kortix');
    expect(body.updatePolicy).toBe('kortix-managed');
    expect(body.files.some((file) => file.target.endsWith('kortix-system/SKILL.md'))).toBe(true);
    expect(body.readme).toContain('Kortix');
  });

  test('GET /marketplace/items honors a limit of 120 (below the 200 clamp ceiling)', async () => {
    const res = await fetch(`${baseUrl}/marketplace/items?source=kortix&limit=120&offset=0`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    // Fewer kortix items exist than 120, so this pins that the full available
    // set came back — i.e. the request wasn't clamped down below its total.
    expect(body.items.length).toBe(body.total);
    expect(body.items.length).toBeGreaterThan(0);
  });
});
