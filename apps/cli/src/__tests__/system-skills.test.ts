import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSystemSkills } from '../commands/system-skills.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const SYSTEM_BODY =
  '---\nname: kortix-system\n---\n\n<skill name="kortix-system">live body</skill>\n';
const SLACK_BODY = '---\nname: kortix-slack\n---\n\nHow to connect Slack.\n';
const REF_CONTENT = '# reference doc\n';

// The system floor as `GET /v1/skills` serves it: name + frontmatter
// description only, no bodies.
const SYSTEM_SKILLS = [
  {
    name: 'kortix-system',
    description: 'How Kortix works. Load whenever the user asks about the platform.',
    referenceCount: 1,
    bytes: 4096,
  },
  { name: 'kortix-slack', description: 'Connect Slack.', referenceCount: 0, bytes: 1024 },
];

const DETAILS: Record<string, unknown> = {
  'kortix-system': {
    name: 'kortix-system',
    description: SYSTEM_SKILLS[0].description,
    body: SYSTEM_BODY,
    references: [{ path: 'references/manifest.md', bytes: REF_CONTENT.length }],
  },
  'kortix-slack': {
    name: 'kortix-slack',
    description: SYSTEM_SKILLS[1].description,
    body: SLACK_BODY,
    references: [],
  },
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
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const path = url.split('/v1/')[1] ?? '';

    // One reference file: /skills/{name}/file?path=… — MUST be matched before
    // the detail branch below, whose `^skills/([^/?]+)` also matches this URL.
    const fileMatch = path.match(/^skills\/([^/?]+)\/file/);
    if (fileMatch) {
      const detail = DETAILS[decodeURIComponent(fileMatch[1])] as any;
      const wanted = new URL(url).searchParams.get('path');
      const ref = detail?.references?.find((f: any) => f.path === wanted);
      if (!ref) {
        return new Response(
          JSON.stringify({ error: true, message: `No file "${wanted}"`, status: 404 }),
          { status: 404 },
        );
      }
      return json({ name: detail.name, path: ref.path, content: REF_CONTENT });
    }

    // Detail: /skills/{name}[?full=1]
    const detailMatch = path.match(/^skills\/([^/?]+)/);
    if (detailMatch) {
      const detail = DETAILS[decodeURIComponent(detailMatch[1])] as any;
      if (!detail) {
        return new Response(JSON.stringify({ error: true, message: 'Not found', status: 404 }), {
          status: 404,
        });
      }
      const full = new URL(url).searchParams.get('full');
      if (full !== '1') return json(detail);
      return json({
        ...detail,
        references: detail.references.map((f: any) => ({ ...f, content: REF_CONTENT })),
      });
    }
    // List: /skills
    if (path === 'skills' || path.startsWith('skills?')) {
      return json({ skills: SYSTEM_SKILLS, count: SYSTEM_SKILLS.length });
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

describe('kortix system-skills — list', () => {
  test('default lists the kortix-managed system floor from /v1/skills', async () => {
    const code = await runSystemSkills([]);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('kortix-system');
    expect(out).toContain('kortix-slack');
    expect(out).toContain('kortix system-skills get <name>');
    // The managed floor is NOT in the browse catalog — querying it was the bug.
    expect(requests.some((u) => u.includes('/v1/skills'))).toBe(true);
    expect(requests.some((u) => u.includes('marketplace'))).toBe(false);
  });

  test('list shows only the first sentence of a paragraph-long description', async () => {
    await runSystemSkills([]);
    const out = stripAnsi(stdout);
    expect(out).toContain('How Kortix works.');
    expect(out).not.toContain('Load whenever the user asks');
  });

  test('--all no longer widens the list — it stays the system floor, and says where the rest went', async () => {
    const code = await runSystemSkills(['list', '--all']);
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('kortix-system');
    expect(requests.some((u) => u.includes('marketplace'))).toBe(false);
    expect(stripAnsi(stderr)).toContain('kortix marketplace list --type skill');
  });

  test('--json emits the whole description, untruncated, on a clean pair of streams', async () => {
    const code = await runSystemSkills(['--json', '--all']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(2);
    expect(parsed.skills.map((s: any) => s.name).sort()).toEqual(['kortix-slack', 'kortix-system']);
    expect(parsed.skills.find((s: any) => s.name === 'kortix-system').description).toContain(
      'Load whenever the user asks',
    );
    // A harness parses this; the redirect note must not land in its way.
    expect(stderr).toBe('');
  });

  test('a host without /v1/skills is named as the problem, not reported as an empty list', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ error: true, message: 'Not found', status: 404 }), {
        status: 404,
      })) as typeof fetch;
    const code = await runSystemSkills([]);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('does not serve system skills yet');
    expect(stripAnsi(stdout)).not.toContain('No system skills found');
  });
});

describe('kortix skills — the retained alias', () => {
  // Every already-baked sandbox image seeds a kortix-system skill whose live
  // pointer says `kortix skills get <name>`, so the old name must keep working.
  test('the alias lists the same system floor', async () => {
    const code = await runSystemSkills([], 'skills');
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('kortix-system');
  });

  test('hints are written in terms of the name that was actually invoked', async () => {
    await runSystemSkills([], 'skills');
    expect(stripAnsi(stdout)).toContain('kortix skills get <name>');
    expect(stripAnsi(stdout)).not.toContain('kortix system-skills get');
  });

  test('the alias still reads a body in full', async () => {
    const code = await runSystemSkills(['get', 'kortix-slack'], 'skills');
    expect(code).toBe(0);
    expect(stdout).toContain('How to connect Slack.');
  });
});

describe('kortix system-skills — get', () => {
  test('prints the live SKILL.md body for a bare skill name', async () => {
    const code = await runSystemSkills(['get', 'kortix-system']);
    expect(code).toBe(0);
    expect(stdout).toContain('<skill name="kortix-system">live body');
    // Bare name is the address — no id namespacing, no search round trip.
    expect(requests.some((u) => u.endsWith('/v1/skills/kortix-system'))).toBe(true);
    expect(requests.length).toBe(1);
  });

  test('--json returns name, description, body and referenced file paths', async () => {
    const code = await runSystemSkills(['get', 'kortix-system', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe('kortix-system');
    expect(parsed.body).toContain('live body');
    expect(parsed.description).toContain('How Kortix works.');
    expect(parsed.files).toEqual(['references/manifest.md']);
  });

  test('--full inlines referenced files in one round trip', async () => {
    const code = await runSystemSkills(['get', 'kortix-system', '--full']);
    expect(code).toBe(0);
    expect(stdout).toContain('===== references/manifest.md =====');
    expect(stdout).toContain('# reference doc');
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain('full=1');
  });

  test('without --full, references are named on stderr but not downloaded', async () => {
    const code = await runSystemSkills(['get', 'kortix-system']);
    expect(code).toBe(0);
    expect(stripAnsi(stderr)).toContain('1 referenced file not shown');
    expect(stdout).not.toContain('# reference doc');
  });

  test('unknown skill exits 1 with a hint', async () => {
    const code = await runSystemSkills(['get', 'does-not-exist']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('No Kortix system skill matches');
  });

  test('missing name exits 2', async () => {
    const code = await runSystemSkills(['get']);
    expect(code).toBe(2);
  });
});

describe('kortix system-skills — path', () => {
  test('resolves the on-disk skill dir under a workspace root', async () => {
    mkdirSync(join(tmp, '.kortix', 'opencode'), { recursive: true });
    const code = await runSystemSkills(['path', 'kortix-system']);
    expect(code).toBe(0);
    expect(stdout.trim().endsWith('.kortix/opencode/skills/kortix-system')).toBe(true);
  });

  test('--json reports the path and whether it exists', async () => {
    const code = await runSystemSkills(['path', 'kortix-memory', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path.endsWith('.kortix/opencode/skills/kortix-memory')).toBe(true);
    expect(parsed.exists).toBe(false);
  });
});

describe('kortix system-skills — file', () => {
  test('prints ONE reference file without pulling the whole tree', async () => {
    const code = await runSystemSkills(['file', 'kortix-system', 'references/manifest.md']);
    expect(code).toBe(0);
    expect(stdout).toContain(REF_CONTENT.trim());
    // The body is NOT fetched — that is the entire point of this subcommand.
    expect(stdout).not.toContain('live body');
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain('/v1/skills/kortix-system/file?path=');
    expect(requests[0]).toContain(encodeURIComponent('references/manifest.md'));
  });

  test('--json wraps the file for scripting', async () => {
    const code = await runSystemSkills([
      'file',
      'kortix-system',
      'references/manifest.md',
      '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe('kortix-system');
    expect(parsed.path).toBe('references/manifest.md');
    expect(parsed.content).toContain(REF_CONTENT.trim());
  });

  test('`ref` is an alias for `file`', async () => {
    const code = await runSystemSkills(['ref', 'kortix-system', 'references/manifest.md']);
    expect(code).toBe(0);
    expect(stdout).toContain(REF_CONTENT.trim());
  });

  test('a missing file points at `get` to list the real paths, and exits non-zero', async () => {
    const code = await runSystemSkills(['file', 'kortix-system', 'references/nope.md']);
    expect(code).toBe(1);
    expect(stderr).toContain('No file "references/nope.md"');
    expect(stderr).toContain('get kortix-system');
  });

  test('missing arguments are a usage error, not a request', async () => {
    const code = await runSystemSkills(['file', 'kortix-system']);
    expect(code).toBe(2);
    expect(requests.length).toBe(0);
    expect(stderr).toContain('pass a skill and a file path');
  });

  test('a bare `get` lists the reference PATHS so `file` is discoverable', async () => {
    const code = await runSystemSkills(['get', 'kortix-system']);
    expect(code).toBe(0);
    // The path is what `file` takes as its argument — a bare count would leave
    // the caller with no way to name it.
    expect(stderr).toContain('references/manifest.md');
    expect(stderr).toContain('file kortix-system');
  });
});
