import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMarketplace } from '../commands/marketplace.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONFIG_FILE = process.env.KORTIX_CONFIG_FILE;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;
const ORIGINAL_SANDBOX_ENV = {
  KORTIX_API_URL: process.env.KORTIX_API_URL,
  KORTIX_CLI_TOKEN: process.env.KORTIX_CLI_TOKEN,
  KORTIX_EXECUTOR_TOKEN: process.env.KORTIX_EXECUTOR_TOKEN,
  KORTIX_FRONTEND_URL: process.env.KORTIX_FRONTEND_URL,
  KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
  KORTIX_TOKEN: process.env.KORTIX_TOKEN,
  BASH_ENV: process.env.BASH_ENV,
  KORTIX_DISABLE_SANDBOX_ENV_FILE: process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE,
};

let tmp: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; authorization: string | null }> = [];

function writeTestConfig() {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = path;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as any).write = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
}

function clearSandboxEnvOverrides() {
  delete process.env.KORTIX_API_URL;
  delete process.env.KORTIX_CLI_TOKEN;
  delete process.env.KORTIX_EXECUTOR_TOKEN;
  delete process.env.KORTIX_FRONTEND_URL;
  delete process.env.KORTIX_PROJECT_ID;
  delete process.env.KORTIX_TOKEN;
  delete process.env.BASH_ENV;
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
}

function restoreSandboxEnvOverrides() {
  for (const [key, value] of Object.entries(ORIGINAL_SANDBOX_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('kortix marketplace', () => {
  beforeEach(() => {
    clearSandboxEnvOverrides();
    tmp = mkdtempSync(join(tmpdir(), 'kortix-marketplace-test-'));
    writeTestConfig();
    captureOutput();
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
    (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
    if (ORIGINAL_CONFIG_FILE === undefined) delete process.env.KORTIX_CONFIG_FILE;
    else process.env.KORTIX_CONFIG_FILE = ORIGINAL_CONFIG_FILE;
    restoreSandboxEnvOverrides();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('searches marketplace items through the API', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      expect(url).toBe('https://api.test/v1/marketplace/items?query=pdf&source=kortix');
      return new Response(
        JSON.stringify({
          items: [{
            id: 'kortix-starter:pdf',
            registry: 'kortix-starter',
            name: 'pdf',
            type: 'registry:skill',
            title: 'PDF',
            description: 'Read and write PDFs.',
            categories: ['general-knowledge-worker'],
            capabilities: { secrets: [], connectors: [], tools: [], network: [] },
            dependencies: [],
            fileCount: 1,
            external: false,
            marketplaceId: 'kortix',
            marketplaceLabel: 'Kortix',
          }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const code = await runMarketplace(['search', 'pdf', '--source', 'kortix', '--json']);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer tok_test');
    expect(JSON.parse(stdout).items[0].id).toBe('kortix-starter:pdf');
    expect(stderr).toBe('');
  });

  test('shows an item by name after resolving it from marketplace search', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      if (url === 'https://api.test/v1/marketplace/items/pdf') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (url === 'https://api.test/v1/marketplace/items?query=pdf') {
        return new Response(
          JSON.stringify({
            items: [{
              id: 'kortix-starter:pdf',
              registry: 'kortix-starter',
              name: 'pdf',
              type: 'registry:skill',
              title: 'PDF',
              description: 'Read and write PDFs.',
              categories: ['general-knowledge-worker'],
              capabilities: { secrets: [], connectors: [], tools: [], network: [] },
              dependencies: [],
              fileCount: 1,
              external: false,
              marketplaceId: 'kortix',
              marketplaceLabel: 'Kortix',
            }],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://api.test/v1/marketplace/items/kortix-starter%3Apdf') {
        return new Response(
          JSON.stringify({
            id: 'kortix-starter:pdf',
            registry: 'kortix-starter',
            name: 'pdf',
            type: 'registry:skill',
            title: 'PDF',
            description: 'Read and write PDFs.',
            categories: ['general-knowledge-worker'],
            capabilities: { secrets: [], connectors: [], tools: [], network: [] },
            dependencies: [],
            fileCount: 1,
            external: false,
            marketplaceId: 'kortix',
            marketplaceLabel: 'Kortix',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }) as typeof fetch;

    const code = await runMarketplace(['show', 'pdf']);

    expect(code).toBe(0);
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.test/v1/marketplace/items/pdf',
      'https://api.test/v1/marketplace/items?query=pdf',
      'https://api.test/v1/marketplace/items/kortix-starter%3Apdf',
    ]);
    expect(stdout).toContain('PDF');
    expect(stdout).toContain('kortix-starter:pdf');
    expect(stderr).toBe('');
  });

  test('lists installed marketplace items for a project', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      expect(url).toBe('https://api.test/v1/projects/proj_1/marketplace');
      return new Response(
        JSON.stringify({
          installed: [{
            name: 'pdf',
            type: 'registry:skill',
            source: 'kortix-starter:pdf',
            installed_at: '2026-01-01T00:00:00.000Z',
            file_count: 1,
          }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const code = await runMarketplace(['status', '--project', 'proj_1', '--json']);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer tok_test');
    expect(JSON.parse(stdout).installed[0].name).toBe('pdf');
    expect(stderr).toBe('');
  });

  test('lists marketplace item update status for a project', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      expect(url).toBe('https://api.test/v1/projects/proj_1/marketplace/updates');
      return new Response(
        JSON.stringify({
          updates: [{ name: 'pdf', type: 'registry:skill', status: 'update-available', changed: 2 }],
          update_available: ['pdf'],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const code = await runMarketplace(['updates', '--project', 'proj_1', '--json']);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer tok_test');
    expect(JSON.parse(stdout).update_available).toEqual(['pdf']);
    expect(stderr).toBe('');
  });

  test('updates an installed marketplace item for a project', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      expect(url).toBe('https://api.test/v1/projects/proj_1/marketplace/update');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'pdf' });
      return new Response(
        JSON.stringify({ ok: true, updated: 'pdf', commit_sha: 'abc12345', branch: 'main', file_count: 2 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const code = await runMarketplace(['update', 'pdf', '--project', 'proj_1', '--json']);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(stdout).updated).toBe('pdf');
    expect(stderr).toBe('');
  });

  test('removes an installed marketplace item for a project', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization) });
      expect(url).toBe('https://api.test/v1/projects/proj_1/marketplace/pdf');
      expect(init?.method).toBe('DELETE');
      return new Response(
        JSON.stringify({ ok: true, removed: 'pdf', commit_sha: 'def67890', branch: 'main', file_count: 1 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const code = await runMarketplace(['remove', 'pdf', '--project', 'proj_1', '--json']);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(stdout).removed).toBe('pdf');
    expect(stderr).toBe('');
  });
});
