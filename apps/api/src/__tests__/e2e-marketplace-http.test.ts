import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: () => Promise<void>) => {
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
    expect(body.items.find((item) => item.name === 'pty')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'web_search')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'pdf')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'kortix')?.managedBy).toBeUndefined();
    expect(body.items.find((item) => item.name === 'memory-reflector')?.managedBy).toBeUndefined();
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
});
