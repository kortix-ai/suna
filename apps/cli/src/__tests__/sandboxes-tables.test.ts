import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSandboxes } from '../commands/sandboxes.ts';
import { stripAnsi } from '../style.ts';

// Characterization for the `sandboxes ls` and `sandboxes builds` tables —
// written before the renderers moved out of the dispatcher, so the column
// layout and the state markers are pinned by test.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';

let route: ((url: URL) => Response | undefined) | null = null;

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
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

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmp = mkdtempSync(join(tmpdir(), 'kortix-sandboxes-'));
  originalCwd = process.cwd();
  process.chdir(tmp);
  process.env.KORTIX_PROJECT_ID = 'proj_sbx';
  writeConfig();
  stdout = '';
  stderr = '';
  route = null;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = (chunk: unknown) => ((stdout += String(chunk)), true);
  stderrStream.write = (chunk: unknown) => ((stderr += String(chunk)), true);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const hit = route?.(url);
    if (hit) return hit;
    return Response.json({ error: 'no route' }, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = ORIGINAL_STDOUT_WRITE as unknown as (chunk: unknown) => boolean;
  stderrStream.write = ORIGINAL_STDERR_WRITE as unknown as (chunk: unknown) => boolean;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix sandboxes — the ls and builds tables', () => {
  test('ls marks the default template and shows source, spec and resources', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_sbx/sandbox-templates') return undefined;
      return Response.json({
        default_slug: 'default',
        items: [
          {
            template_id: 'tpl_1',
            slug: 'default',
            source: 'kortix.yaml',
            daytona_state: 'active',
            ready: true,
            has_image: false,
            has_dockerfile: true,
            dockerfile_path: 'default.Dockerfile',
            cpu: 2,
            memory_gb: 4,
            disk_gb: 10,
          },
          {
            template_id: 'tpl_2',
            slug: 'gpu-worker',
            source: 'image',
            daytona_state: 'inactive',
            ready: false,
            has_image: true,
            image: 'registry.io/gpu:1',
            has_dockerfile: false,
            cpu: 8,
            memory_gb: 32,
            disk_gb: 50,
          },
        ],
      });
    };
    const code = await runSandboxes(['ls']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('SLUG');
    expect(out).toContain('default.Dockerfile');
    expect(out).toContain('registry.io/gpu:1');
    expect(out).toContain('2cpu/4g/10g');
    expect(out).toContain('8cpu/32g/50g');
    expect(out).toContain('default: default');
    // The default template carries the filled marker; the other row does not.
    const defaultRow = out.split('\n').find((l) => l.includes('default ') && l.includes('kortix.yaml')) ?? '';
    const otherRow = out.split('\n').find((l) => l.includes('gpu-worker')) ?? '';
    expect(defaultRow.startsWith('● ')).toBe(true);
    expect(otherRow.startsWith('● ')).toBe(false);
  });

  test('ls --json emits the raw payload', async () => {
    const payload = { default_slug: null, items: [] };
    route = () => Response.json(payload);
    const code = await runSandboxes(['ls', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(payload);
  });

  test('builds lists snapshot builds and names a failure with its category', async () => {
    route = (url) => {
      if (url.pathname !== '/v1/projects/proj_sbx/snapshots') return undefined;
      return Response.json({
        builds: [
          {
            build_id: 'b1',
            slug: 'default',
            status: 'ready',
            source: 'kortix.yaml',
            started_at: '2026-08-01T10:00:00.000Z',
          },
          {
            build_id: 'b2',
            slug: 'gpu-worker',
            status: 'failed',
            error: 'dockerfile parse error: line 4\nsecond line',
            error_category: 'provider',
            source: 'kortix.yaml',
            started_at: '2026-08-01T11:00:00.000Z',
          },
        ],
      });
    };
    const code = await runSandboxes(['builds']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('SLUG');
    expect(out).toContain('ready');
    expect(out).toContain('dockerfile parse error: line 4');
    expect(out).not.toContain('second line');
    expect(out).toContain('[provider]');
    expect(out).toContain('2 builds');
  });

  test('builds with nothing yet says so', async () => {
    route = () => Response.json({ builds: [] });
    const code = await runSandboxes(['builds']);
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('No builds yet.');
  });
});
