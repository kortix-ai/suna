import { describe, expect, test } from 'bun:test';
import {
  TELEGRAM_CHANNEL_CONNECTOR_SLUG,
  channelApiBase,
  channelAuth,
  channelCatalog,
  channelDefaultSlug,
  channelLabel,
} from './channels';
import { executeCall, paramHintsFromSchema } from './execute';
import type { NormalizedAction } from './types';

/**
 * The token-isolation contract for the Telegram channel connector: the bot
 * token is substituted into the URL path SERVER-SIDE (auth in:'path'), callers
 * can neither supply nor read it, and transport errors never echo it.
 */

const TOKEN = '1234567890:AAF0eXaMpLeToKeNBoDy_1234-abcdEFGHijk';
const BASE = 'https://api.telegram.org';

function action(path: string): NormalizedAction {
  const found = channelCatalog('telegram').find((a) => a.path === path);
  if (!found) throw new Error(`telegram action ${path} missing from catalog`);
  return found;
}

function mockFetch(capture: { url?: string; method?: string; headers?: Record<string, string>; body?: string }) {
  return async (url: string | URL, init?: RequestInit) => {
    capture.url = String(url);
    capture.method = init?.method ?? 'GET';
    capture.headers = (init?.headers ?? {}) as Record<string, string>;
    capture.body = typeof init?.body === 'string' ? init.body : undefined;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('telegram channel catalog', () => {
  test('registered under the reserved platform-owned slug', () => {
    expect(channelDefaultSlug('telegram')).toBe(TELEGRAM_CHANNEL_CONNECTOR_SLUG);
    expect(TELEGRAM_CHANNEL_CONNECTOR_SLUG).toBe('kortix_telegram');
    expect(channelLabel('telegram')).toBe('Telegram');
  });

  test('exposes the curated send/read/file surface with sane risks', () => {
    const byPath = new Map(channelCatalog('telegram').map((a) => [a.path, a]));
    expect([...byPath.keys()].sort()).toEqual([
      'edit_message_text',
      'get_chat',
      'get_file',
      'send_chat_action',
      'send_document',
      'send_message',
    ]);
    expect(byPath.get('send_message')!.risk).toBe('write');
    expect(byPath.get('get_file')!.risk).toBe('read');
    expect(byPath.get('get_chat')!.risk).toBe('read');
  });

  test('auth is path-placed and the token placeholder is NOT an input property', () => {
    expect(channelAuth('telegram')).toEqual({ type: 'custom', in: 'path', name: 'token', prefix: null });
    for (const a of channelCatalog('telegram')) {
      const props = (a.inputSchema as any)?.properties ?? {};
      expect(props.token).toBeUndefined();
      expect((a.binding as any).path).toContain('{token}');
    }
  });

  test('api base honors the e2e stub override', () => {
    process.env.KORTIX_TELEGRAM_API_BASE = 'http://127.0.0.1:4567/';
    try {
      expect(channelApiBase('telegram')).toBe('http://127.0.0.1:4567');
    } finally {
      delete process.env.KORTIX_TELEGRAM_API_BASE;
    }
    expect(channelApiBase('telegram')).toBe(BASE);
  });
});

describe('telegram executeCall — token isolation', () => {
  test('send_message: token lands in the URL path, never in headers or body', async () => {
    const a = action('send_message');
    const capture: Record<string, any> = {};
    const res = await executeCall({
      binding: a.binding,
      baseUrl: channelApiBase('telegram'),
      auth: channelAuth('telegram'),
      secret: TOKEN,
      args: { chat_id: '-100555', text: 'hello', parse_mode: 'HTML' },
      paramHints: paramHintsFromSchema(a.inputSchema as any),
      fetchImpl: mockFetch(capture) as any,
    });
    expect(res.ok).toBe(true);
    expect(capture.url).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
    expect(capture.method).toBe('POST');
    expect(capture.headers.Authorization).toBeUndefined();
    const body = JSON.parse(capture.body!);
    expect(body).toEqual({ chat_id: '-100555', text: 'hello', parse_mode: 'HTML' });
    expect(capture.body).not.toContain(TOKEN);
  });

  test('a malicious `token` arg cannot override or read the credential', async () => {
    const a = action('send_message');
    const capture: Record<string, any> = {};
    await executeCall({
      binding: a.binding,
      baseUrl: BASE,
      auth: channelAuth('telegram'),
      secret: TOKEN,
      args: { chat_id: '1', text: 'x', token: 'attacker:override' },
      paramHints: paramHintsFromSchema(a.inputSchema as any),
      fetchImpl: mockFetch(capture) as any,
    });
    // The real token is already substituted before arg templating — the stray
    // arg falls through to the JSON body where Telegram ignores it.
    expect(capture.url).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(capture.body!).token).toBe('attacker:override');
  });

  test('GET actions carry args as query, token still path-only', async () => {
    const a = action('get_file');
    const capture: Record<string, any> = {};
    await executeCall({
      binding: a.binding,
      baseUrl: BASE,
      auth: channelAuth('telegram'),
      secret: TOKEN,
      args: { file_id: 'ABC-123' },
      paramHints: paramHintsFromSchema(a.inputSchema as any),
      fetchImpl: mockFetch(capture) as any,
    });
    expect(capture.url).toBe(`${BASE}/bot${TOKEN}/getFile?file_id=ABC-123`);
    expect(capture.method).toBe('GET');
    expect(capture.headers.Authorization).toBeUndefined();
  });

  test('transport errors are redacted — the token never reaches the caller', async () => {
    const a = action('send_message');
    const failing = async (url: string | URL) => {
      throw new Error(`Unable to connect to ${String(url)}`);
    };
    let message = '';
    try {
      await executeCall({
        binding: a.binding,
        baseUrl: BASE,
        auth: channelAuth('telegram'),
        secret: TOKEN,
        args: { chat_id: '1', text: 'x' },
        paramHints: paramHintsFromSchema(a.inputSchema as any),
        fetchImpl: failing as any,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('bot<redacted>');
    expect(message).not.toContain(TOKEN);
  });

  test('missing credential degrades to an empty placeholder (no crash, no leak)', async () => {
    const a = action('send_message');
    const capture: Record<string, any> = {};
    await executeCall({
      binding: a.binding,
      baseUrl: BASE,
      auth: channelAuth('telegram'),
      secret: null,
      args: { chat_id: '1', text: 'x' },
      paramHints: paramHintsFromSchema(a.inputSchema as any),
      fetchImpl: mockFetch(capture) as any,
    });
    expect(capture.url).toBe(`${BASE}/bot/sendMessage`);
  });
});
