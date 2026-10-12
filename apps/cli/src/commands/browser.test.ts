import { afterEach, describe, expect, test } from 'bun:test';

import { stripAnsi } from '../style.ts';
import { browserLabel, formatBrowserError, formatBrowserList, formatUsed, runBrowser } from './browser.ts';

describe('browser output', () => {
  test('use success matches the protocol example', () => {
    expect(stripAnsi(formatUsed({ name: 'Chrome · Work', os: 'macOS' }))).toBe(
      '  ✓  Using Chrome · Work (macOS)\n     Drive it: agent-browser --cdp 9333 open https://example.com',
    );
  });

  test('not connected prints the connect link', () => {
    const out = stripAnsi(
      formatBrowserError({
        error: 'No browser is connected to Kortix.',
        code: 'browser_not_connected',
        connectUrl: 'https://kortix.com/settings/browsers',
      }),
    );
    expect(out).toContain('✗  No browser is connected to Kortix.');
    expect(out).toContain('Ask the user to connect one: https://kortix.com/settings/browsers');
  });

  test('denied tells the agent to ask first', () => {
    expect(stripAnsi(formatBrowserError({ error: 'The user stopped this.', code: 'browser_denied' }))).toContain(
      'kortix browser use --ask',
    );
  });

  test('empty list points at the connect page', () => {
    expect(stripAnsi(formatBrowserList([], 'https://kortix.com/settings/browsers'))).toContain('settings/browsers');
    expect(browserLabel({ brand: 'Chrome', os: 'macOS' })).toBe('Chrome (macOS)');
    expect(browserLabel({ name: 'Chrome on macOS', brand: 'Chrome', os: 'macOS' })).toBe('Chrome on macOS');
  });
});

describe('runBrowser against a daemon', () => {
  const saved = { ...process.env };
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
    process.env = { ...saved };
  });

  async function capture(argv: string[]) {
    let out = '';
    let err = '';
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => ((out += s), true)) as never;
    process.stderr.write = ((s: string) => ((err += s), true)) as never;
    try {
      const code = await runBrowser(argv);
      return { code, out: stripAnsi(out), err: stripAnsi(err) };
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
  }

  test('outside a session, use says it runs only inside one', async () => {
    delete process.env.KORTIX_TOKEN;
    const r = await capture(['use']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('runs only inside a Kortix session');
  });

  test('use, status, release call kortixd with the bearer and print the result', async () => {
    const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = req.method === 'POST' ? await req.json() : null;
        seen.push({ method: req.method, path, auth: req.headers.get('authorization'), body });
        if (path.endsWith('/attach')) {
          return Response.json({ attachmentId: 'a', browser: { name: 'Chrome · Work', os: 'macOS' }, cdpPort: 9333 });
        }
        if (path.endsWith('/release')) return new Response(null, { status: 204 });
        return Response.json({ attached: true, browser: { name: 'Chrome · Work', os: 'macOS' }, clients: 2, cdpPort: 9333 });
      },
    });
    process.env.KORTIX_TOKEN = 'tok';
    process.env.KORTIX_SERVICE_PORT = String(server.port);

    const use = await capture(['use', 'Work', '--ask']);
    expect(use.code).toBe(0);
    expect(use.out).toContain('Using Chrome · Work (macOS)');
    expect(seen[0]).toEqual({ method: 'POST', path: '/kortix/browser/attach', auth: 'Bearer tok', body: { browser: 'Work', ask: true } });

    const st = await capture(['status']);
    expect(st.out).toContain('Attached: Chrome · Work (macOS) · 2 CDP clients');

    const rel = await capture(['release', '--json']);
    expect(rel.code).toBe(0);
    expect(JSON.parse(rel.out)).toEqual({ released: true });
  });

  test('an API error from kortixd exits 1 with the connect link', async () => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json(
          { error: 'No browser is connected to Kortix.', code: 'browser_not_connected', connectUrl: 'https://kortix.com/settings/browsers' },
          { status: 404 },
        ),
    });
    process.env.KORTIX_TOKEN = 'tok';
    process.env.KORTIX_SERVICE_PORT = String(server.port);
    const r = await capture(['use']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('https://kortix.com/settings/browsers');
  });
});
