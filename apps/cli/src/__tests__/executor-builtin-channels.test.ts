import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runExecutor } from '../commands/executor.ts';

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

describe('kortix executor — built-in channel slugs', () => {
  test('add slack is rejected client-side and points at `kortix channels connect`', async () => {
    const code = await runExecutor(['add', 'slack', '--provider', 'pipedream', '--app', 'slack']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BUILTIN_CHANNEL');
    expect(parsed.error).toContain('kortix channels connect');
    expect(fetchCalls).toBe(0);
  });

  test('connect slack is rejected the same way', async () => {
    const code = await runExecutor(['connect', 'slack']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('BUILTIN_CHANNEL');
    expect(parsed.error).toContain('kortix channels connect');
    expect(fetchCalls).toBe(0);
  });

  test('add kortix_slack is rejected too', async () => {
    const code = await runExecutor(['add', 'kortix_slack', '--provider', 'pipedream', '--app', 'slack']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).code).toBe('BUILTIN_CHANNEL');
  });
});
