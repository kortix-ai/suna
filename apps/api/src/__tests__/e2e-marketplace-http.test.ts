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

  test('GET /marketplace/items surfaces the starter project + its skills; managed kortix-* skills stay internal', async () => {
    const res = await fetch(`${baseUrl}/marketplace/items?source=kortix`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; name: string; type: string; managedBy?: string; partOfProject?: { id: string; title: string } }> };

    // Kortix-managed system skills (kortix-computer/executor/memory/slack/system/
    // marketplace/meet/onboarding) are server-injected platform floor now — they
    // never show up as browse-and-install cards.
    expect(body.items.some((item) => item.managedBy === 'kortix')).toBe(false);
    for (const name of ['kortix-computer', 'kortix-executor', 'kortix-memory', 'kortix-slack', 'kortix-system']) {
      expect(body.items.find((item) => item.name === name)).toBeUndefined();
    }

    // Browse leads with the "Kortix Starter" project AND lists the individual
    // kortix-starter skills (agent-browser, pdf, …) as their own top-level
    // tiles again — each one carries a `partOfProject` badge back to the project.
    expect(body.items.find((item) => item.id === 'kortix-projects:starter')).toBeTruthy();
    const agentBrowser = body.items.find((item) => item.name === 'agent-browser');
    expect(agentBrowser).toBeTruthy();
    expect(agentBrowser?.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'Kortix Starter' });
    expect(body.items.find((item) => item.name === 'pdf')).toBeTruthy();
    expect(body.items.find((item) => item.name === 'pty')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'web_search')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'kortix')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'memory-reflector')).toBeUndefined();
  });

  test('GET /marketplace/items is public read-only', async () => {
    authCalls = 0;
    const res = await fetch(`${baseUrl}/marketplace/items?query=agent-browser&source=kortix`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; name: string; type: string }> };
    expect(body.items).toContainEqual(
      expect.objectContaining({ id: 'kortix-starter:agent-browser', type: 'registry:skill' }),
    );
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

  test('GET /marketplace/items/:id exposes the starter project detail and its skills; managed system skills stay unreachable', async () => {
    const detail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-projects:starter')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      name: string;
      type: string;
      dependencyItems: Array<{ name: string; type: string }>;
      files: Array<{ target: string; type: string }>;
      readme: string | null;
    };

    expect(body.name).toBe('starter');
    expect(body.type).toBe('registry:project');
    // The "what's inside" list resolves the kortix-starter skills, typed.
    expect(body.dependencyItems.some((d) => d.name === 'pdf')).toBe(true);

    // A starter skill is also reachable as its own browse-and-install card, at
    // its own id, badged back to the project it also ships inside of.
    const skillDetail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-starter:agent-browser')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(skillDetail.status).toBe(200);
    const skillBody = await skillDetail.json() as {
      name: string;
      type: string;
      partOfProject?: { id: string; title: string };
    };
    expect(skillBody.name).toBe('agent-browser');
    expect(skillBody.type).toBe('registry:skill');
    expect(skillBody.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'Kortix Starter' });

    // Kortix-managed system skills are server-injected platform truth — never a
    // browse-and-detail card, even by a hand-built id.
    const managed = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-starter:kortix-system')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(managed.status).toBe(404);
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
