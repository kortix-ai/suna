import { afterEach, describe, expect, test } from 'bun:test';

import { stripAnsi } from '../style.ts';
import { chromeLabel, formatChromeError, formatChromeList, formatUsed, runChrome } from './chrome.ts';

describe('browser output', () => {
  test('use success matches the protocol example, and names the tab scope', () => {
    expect(stripAnsi(formatUsed({ name: 'Chrome · Work', os: 'macOS', tabScope: 'all' }))).toBe(
      "  ✓  Using Chrome · Work (macOS)\n     Tabs: all of the user's tabs, every window (`agent-browser --cdp 9333 tab list`); you start in a tab of your own\n     Drive it: agent-browser --cdp 9333 open https://example.com",
    );
    expect(stripAnsi(formatUsed({ name: 'Chrome · Work', os: 'macOS', tabScope: 'own' }))).toContain(
      'Tabs: only the tabs you open',
    );
  });

  test('not connected prints the connect link', () => {
    const out = stripAnsi(
      formatChromeError({
        error: 'No browser is connected to Kortix.',
        code: 'chrome_not_connected',
        connectUrl: 'https://kortix.com/settings/chrome',
      }),
    );
    expect(out).toContain('✗  No browser is connected to Kortix.');
    expect(out).toContain('Ask the user to connect one: https://kortix.com/settings/chrome');
  });

  test('denied tells the agent to ask first', () => {
    expect(stripAnsi(formatChromeError({ error: 'The user stopped this.', code: 'chrome_denied' }))).toContain(
      'kortix chrome use --ask',
    );
  });

  test('empty list points at the connect page', () => {
    expect(stripAnsi(formatChromeList([], 'https://kortix.com/settings/chrome'))).toContain('settings/chrome');
    expect(chromeLabel({ brand: 'Chrome', os: 'macOS' })).toBe('Chrome (macOS)');
    expect(chromeLabel({ name: 'Chrome on macOS', brand: 'Chrome', os: 'macOS' })).toBe('Chrome on macOS');
  });
});

describe('runChrome against a daemon', () => {
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
      const code = await runChrome(argv);
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
          return Response.json({ attachmentId: 'a', chrome: { name: 'Chrome · Work', os: 'macOS' }, cdpPort: 9333 });
        }
        if (path.endsWith('/release')) return new Response(null, { status: 204 });
        return Response.json({ attached: true, chrome: { name: 'Chrome · Work', os: 'macOS' }, clients: 2, cdpPort: 9333 });
      },
    });
    process.env.KORTIX_TOKEN = 'tok';
    process.env.KORTIX_SERVICE_PORT = String(server.port);

    const use = await capture(['use', 'Work', '--ask']);
    expect(use.code).toBe(0);
    expect(use.out).toContain('Using Chrome · Work (macOS)');
    expect(seen[0]).toEqual({ method: 'POST', path: '/kortix/chrome/attach', auth: 'Bearer tok', body: { chrome: 'Work', ask: true } });

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
          { error: 'No browser is connected to Kortix.', code: 'chrome_not_connected', connectUrl: 'https://kortix.com/settings/chrome' },
          { status: 404 },
        ),
    });
    process.env.KORTIX_TOKEN = 'tok';
    process.env.KORTIX_SERVICE_PORT = String(server.port);
    const r = await capture(['use']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('https://kortix.com/settings/chrome');
  });
});
