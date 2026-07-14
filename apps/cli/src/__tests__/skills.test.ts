import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkills } from '../commands/skills.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const SYSTEM_BODY = '---\nname: kortix-system\n---\n\n<skill name="kortix-system">live body</skill>\n';
const SLACK_BODY = '---\nname: kortix-slack\n---\n\nHow to connect Slack.\n';
const REF_CONTENT = '# reference doc\n';

// Two managed system skills + one ordinary (non-managed) skill, so the default
// list can be checked against the managed floor and `--all` against everything.
const ITEMS = [
  {
    id: 'kortix-starter:kortix-system',
    name: 'kortix-system',
    type: 'registry:skill',
    title: 'kortix-system',
    description: 'How Kortix works.',
    categories: ['kortix-managed'],
    managedBy: 'kortix',
    updatePolicy: 'kortix-managed',
  },
  {
    id: 'kortix-starter:kortix-slack',
    name: 'kortix-slack',
    type: 'registry:skill',
    title: 'kortix-slack',
    description: 'Connect Slack.',
    categories: ['kortix-managed'],
    managedBy: 'kortix',
    updatePolicy: 'kortix-managed',
  },
  {
    id: 'kortix-starter:pdf',
    name: 'pdf',
    type: 'registry:skill',
    title: 'pdf',
    description: 'Work with PDFs.',
    categories: [],
  },
];

const DETAILS: Record<string, unknown> = {
  'kortix-starter:kortix-system': {
    ...ITEMS[0],
    readme: SYSTEM_BODY,
    files: [
      { target: '@skills/kortix-system/SKILL.md', type: 'registry:file' },
      { target: '@skills/kortix-system/references/manifest.md', type: 'registry:file' },
    ],
  },
  'kortix-starter:kortix-slack': { ...ITEMS[1], readme: SLACK_BODY, files: [] },
};

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: string[] = [];

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
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
  process.env.KORTIX_CONFIG_FILE = file;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown) => ((stderr += String(chunk)), true);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockApi() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const path = url.split('/v1/')[1] ?? '';

    // File endpoint: /marketplace/items/{id}/file?path={target}
    const fileMatch = path.match(/^marketplace\/items\/([^/]+)\/file/);
    if (fileMatch) {
      const target = new URL(url).searchParams.get('path') ?? '';
      return json({ target, content: REF_CONTENT });
    }
    // Detail: /marketplace/items/{id}
    const detailMatch = path.match(/^marketplace\/items\/([^/?]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const detail = DETAILS[id];
      if (!detail) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      return json(detail);
    }
    // List: /marketplace/items?...
    if (path.startsWith('marketplace/items')) {
      return json({ items: ITEMS, total: ITEMS.length, hasMore: false });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-skills-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix skills — list', () => {
  test('default lists only the kortix-managed system floor', async () => {
    const code = await runSkills([]);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('kortix-system');
    expect(out).toContain('kortix-slack');
    expect(out).not.toContain('pdf');
    expect(out).toContain('kortix skills get <name>');
  });

  test('--all includes non-managed skills too', async () => {
    const code = await runSkills(['list', '--all']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('pdf');
    expect(out).toContain('kortix-system');
  });

  test('--json emits the filtered system floor as data', async () => {
    const code = await runSkills(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.skills.map((s: any) => s.name).sort()).toEqual(['kortix-slack', 'kortix-system']);
  });
});

describe('kortix skills — get', () => {
  test('prints the live SKILL.md body for a bare skill name', async () => {
    const code = await runSkills(['get', 'kortix-system']);
    expect(code).toBe(0);
    expect(stdout).toContain('<skill name="kortix-system">live body');
    // resolved name -> namespaced id, then fetched detail by id
    expect(requests.some((u) => u.includes('marketplace/items/kortix-starter%3Akortix-system'))).toBe(true);
  });

  test('--json returns name, id, body and referenced file targets', async () => {
    const code = await runSkills(['get', 'kortix-system', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe('kortix-system');
    expect(parsed.id).toBe('kortix-starter:kortix-system');
    expect(parsed.body).toContain('live body');
    expect(parsed.managedBy).toBe('kortix');
    expect(parsed.files).toEqual(['@skills/kortix-system/references/manifest.md']);
  });

  test('--full fetches and appends referenced files', async () => {
    const code = await runSkills(['get', 'kortix-system', '--full']);
    expect(code).toBe(0);
    expect(stdout).toContain('===== @skills/kortix-system/references/manifest.md =====');
    expect(stdout).toContain('# reference doc');
  });

  test('unknown skill exits 1 with a hint', async () => {
    const code = await runSkills(['get', 'does-not-exist']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('No Kortix skill matches');
  });

  test('missing name exits 2', async () => {
    const code = await runSkills(['get']);
    expect(code).toBe(2);
  });
});

describe('kortix skills — path', () => {
  test('resolves the on-disk skill dir under a project root', async () => {
    mkdirSync(join(tmp, '.kortix', 'opencode'), { recursive: true });
    const code = await runSkills(['path', 'kortix-system']);
    expect(code).toBe(0);
    expect(stdout.trim().endsWith('.kortix/opencode/skills/kortix-system')).toBe(true);
  });

  test('--json reports the path and whether it exists', async () => {
    const code = await runSkills(['path', 'kortix-memory', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path.endsWith('.kortix/opencode/skills/kortix-memory')).toBe(true);
    expect(parsed.exists).toBe(false);
  });
});
