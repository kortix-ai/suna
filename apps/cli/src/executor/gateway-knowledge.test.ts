import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readKnowledge, searchKnowledge } from './gateway.ts';

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_CONFIG_FILE',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

const originalFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
let calls: Array<{
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_CLI_TOKEN = 'kortix_pat_knowledge';
  process.env.KORTIX_API_URL = 'https://tunnel.example/v1';
  process.env.KORTIX_PROJECT_ID = 'project-1';
  process.env.KORTIX_SESSION_ID = 'session-1';
  process.env.KORTIX_CONFIG_FILE = '/nonexistent/kortix-knowledge-test.json';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      authorization: new Headers(options.headers).get('authorization'),
      body: options.body ? JSON.parse(String(options.body)) : undefined,
    });
    return Response.json(
      String(url).endsWith('/knowledge/search')
        ? { results: [], mode: 'lexical', degraded_reason: null }
        : { content: 'Private evidence.', citation: { citation_id: 'citation-1' } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('executor knowledge transport', () => {
  test('uses the session-scoped SDK search and citation routes', async () => {
    await searchKnowledge('incident policy', 5);
    await readKnowledge('citation-1');

    expect(calls).toEqual([
      {
        url: 'https://tunnel.example/v1/projects/project-1/sessions/session-1/knowledge/search',
        method: 'POST',
        authorization: 'Bearer kortix_pat_knowledge',
        body: { query: 'incident policy', limit: 5 },
      },
      {
        url: 'https://tunnel.example/v1/projects/project-1/sessions/session-1/knowledge/citation-1',
        method: 'GET',
        authorization: 'Bearer kortix_pat_knowledge',
        body: undefined,
      },
    ]);
  });

  test('rejects use outside an authenticated Kortix session', () => {
    delete process.env.KORTIX_SESSION_ID;
    expect(() => searchKnowledge('incident policy')).toThrow('KORTIX_SESSION_ID is not set');
    expect(calls).toEqual([]);
  });
});
