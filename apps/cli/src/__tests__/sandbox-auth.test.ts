import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { activeHost } from '../api/config.ts';
import { createApiClient } from '../api/client.ts';
import { resolveProjectId } from '../project-link.ts';

// These tests pin the contract the platform relies on when it injects auth
// into a session sandbox: KORTIX_CLI_TOKEN / KORTIX_EXECUTOR_TOKEN carry the
// project-scoped PAT, KORTIX_API_URL already includes the `/v1` mount, and
// KORTIX_PROJECT_ID selects the project — all read with zero config files.

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Point config storage at a path that does not exist so no real auth leaks in.
  process.env.KORTIX_CONFIG_FILE = '/nonexistent/kortix-test-config.json';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('in-sandbox auth resolution', () => {
  it('uses KORTIX_CLI_TOKEN as the active token', () => {
    process.env.KORTIX_CLI_TOKEN = 'kortix_pat_cli';
    process.env.KORTIX_API_URL = 'https://tunnel.example/v1';
    const host = activeHost();
    expect(host?.token).toBe('kortix_pat_cli');
    expect(host?.url).toBe('https://tunnel.example/v1');
  });

  it('falls back to KORTIX_EXECUTOR_TOKEN when KORTIX_CLI_TOKEN is unset', () => {
    process.env.KORTIX_EXECUTOR_TOKEN = 'kortix_pat_exec';
    const host = activeHost();
    expect(host?.token).toBe('kortix_pat_exec');
  });

  it('does NOT treat KORTIX_TOKEN (the sandbox service key) as a CLI token', () => {
    process.env.KORTIX_TOKEN = 'kortix_sb_sandboxkey';
    // With no CLI/executor token and a missing config file we fall through to
    // the default (logged-out) host — crucially, the sandbox key is never
    // adopted as the active token. `resolveProjectContext` treats an empty
    // token as "not logged in".
    expect(activeHost()?.token || '').not.toBe('kortix_sb_sandboxkey');
    expect(activeHost()?.token || '').toBe('');
  });

  it('reads the project id from KORTIX_PROJECT_ID', () => {
    process.env.KORTIX_PROJECT_ID = 'proj-xyz';
    expect(resolveProjectId()).toBe('proj-xyz');
  });
});

describe('API URL joining', () => {
  let calls: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('does not double the /v1 mount when the base already ends in /v1', async () => {
    // This is exactly the sandbox shape: KORTIX_API_URL = https://<tunnel>/v1
    const client = createApiClient({ apiBase: 'https://tunnel.example/v1', token: 't' });
    await client.get('/projects/p1/change-requests');
    expect(calls[0]).toBe('https://tunnel.example/v1/projects/p1/change-requests');
  });

  it('adds the /v1 mount when the base is a bare origin', async () => {
    const client = createApiClient({ apiBase: 'https://api.kortix.com', token: 't' });
    await client.get('/projects/p1/change-requests');
    expect(calls[0]).toBe('https://api.kortix.com/v1/projects/p1/change-requests');
  });

  it('tolerates a trailing slash on the base', async () => {
    const client = createApiClient({ apiBase: 'https://tunnel.example/v1/', token: 't' });
    await client.get('/projects/p1/change-requests');
    expect(calls[0]).toBe('https://tunnel.example/v1/projects/p1/change-requests');
  });
});
