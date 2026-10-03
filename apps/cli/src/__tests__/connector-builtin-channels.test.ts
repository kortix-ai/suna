import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConnector } from '../commands/connector-gateway.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;

let stdout = '';
let fetchCalls = 0;

beforeEach(() => {
  stdout = '';
  fetchCalls = 0;
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
});

describe('kortix connectors — built-in channel slugs', () => {
  test('add slack is rejected client-side and points at `kortix channels connect`', async () => {
    const code = await runConnector(['add', 'slack', '--provider', 'pipedream', '--app', 'slack']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BUILTIN_CHANNEL');
    expect(parsed.error).toContain('kortix channels connect');
    expect(fetchCalls).toBe(0);
  });

  test('connect slack is rejected the same way', async () => {
    const code = await runConnector(['connect', 'slack']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('BUILTIN_CHANNEL');
    expect(parsed.error).toContain('kortix channels connect');
    expect(fetchCalls).toBe(0);
  });

  test('add kortix_slack is rejected too', async () => {
    const code = await runConnector([
      'add',
      'kortix_slack',
      '--provider',
      'pipedream',
      '--app',
      'slack',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).code).toBe('BUILTIN_CHANNEL');
  });
});

describe('kortix connectors — unknown subcommand', () => {
  test('falls through to the same help object for an unknown name and for no name', async () => {
    const helpObject = {
      name: 'kortix connectors',
      description:
        'One interface to every configured connector. Calls run server-side; no secrets in the sandbox.',
      commands: {
        ls: expect.any(String),
        discover: expect.any(String),
        show: expect.any(String),
        call: expect.any(String),
        upload: expect.any(String),
        add: expect.any(String),
        rm: expect.any(String),
        accounts: expect.any(String),
        connect: expect.any(String),
        mcp: 'kortix connectors mcp — run the optional stdio MCP compatibility server',
      },
    };
    expect(await runConnector(['definitely-not-a-subcommand'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual(helpObject);
    stdout = '';
    expect(await runConnector([])).toBe(0);
    expect(JSON.parse(stdout)).toEqual(helpObject);
    // Neither path touches the gateway.
    expect(fetchCalls).toBe(0);
  });
});
