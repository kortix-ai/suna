import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

type Violation = { rule: string; index: number; match: string; message: string };
type FileViolation = Violation & { file: string; line: number };
type ScanOptions = { test?: boolean; transport?: boolean };
type BoundaryModule = {
  TRANSPORT_ALLOWLIST: string[];
  scanSource: (source: string, options?: ScanOptions) => Violation[];
  scanCliBoundary: (root?: string) => FileViolation[];
};

const { TRANSPORT_ALLOWLIST, scanCliBoundary, scanSource } = (await import(
  new URL('../../scripts/sdk-boundary.mjs', import.meta.url).href
)) as BoundaryModule;

function rules(source: string, options?: ScanOptions): string[] {
  return scanSource(source, options).map((violation) => violation.rule);
}

describe('scanSource raw-kortix-fetch', () => {
  test('flags a fetch whose template base is interpolated', () => {
    const source = 'const r = await fetch(`${base}/v1/workspaces`);';

    expect(rules(source)).toContain('raw-kortix-fetch');
  });

  test('flags a fetch whose target is a bare variable', () => {
    const source = 'const r = await fetch(url, { method: "GET" });';

    expect(rules(source)).toContain('raw-kortix-fetch');
  });

  test('allows the GitHub releases API', () => {
    const source = "await fetch('https://api.github.com/repos/kortix-ai/CompanyOS/releases/latest')";

    expect(scanSource(source)).toEqual([]);
  });

  test('allows the Docker Hub tags API', () => {
    const source = "await fetch('https://hub.docker.com/v2/repositories/x/tags')";

    expect(scanSource(source)).toEqual([]);
  });

  test("allows a self-host's own acme-dns API on its one loopback port, and no other loopback port", () => {
    expect(scanSource("await fetch('http://127.0.0.1:13750/register', { method: 'POST' })")).toEqual([]);
    expect(scanSource("await fetch('http://127.0.0.1:8008/v1/workspaces')").map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
    expect(scanSource("await fetch('http://127.0.0.1:137500/x')").map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
  });

  test('allows a template whose static prefix is an allowed origin', () => {
    const source = 'await fetch(`https://hub.docker.com/v2/repositories/${repo}/tags`)';

    expect(scanSource(source)).toEqual([]);
  });

  test('is not applied to test files', () => {
    const source = 'const r = await fetch(`${base}/v1/workspaces`);';

    expect(scanSource(source, { test: true })).toEqual([]);
  });

  test('is not applied to the transport adapter', () => {
    const source = 'const r = await fetch(`${base}/v1/workspaces`);';

    expect(scanSource(source, { transport: true })).toEqual([]);
  });
});

describe('scanSource runtime-rest-path', () => {
  test('flags a prompt_async path', () => {
    const source = 'const path = `/session/${id}/prompt_async`;';

    expect(rules(source)).toContain('runtime-rest-path');
  });

  test('flags a permission reply path', () => {
    const source = 'const path = `/permission/${id}/reply`;';

    expect(rules(source)).toContain('runtime-rest-path');
  });

  test('flags a question reject path', () => {
    const source = 'const path = `/question/${id}/reject`;';

    expect(rules(source)).toContain('runtime-rest-path');
  });

  test('flags a bare session request path', () => {
    const source = "await client.get('/session');";

    expect(rules(source)).toContain('runtime-rest-path');
  });

  test('does not flag an unrelated path segment', () => {
    const source = "const path = '/sessions/list';";

    expect(scanSource(source)).toEqual([]);
  });
});

describe('scanSource runtime-proxy-url', () => {
  test('flags a hand-built proxy URL on port 8000', () => {
    const source = 'const url = `${apiBase}/p/${externalId}/8000`;';

    expect(rules(source)).toContain('runtime-proxy-url');
  });

  test('flags a hand-built proxy URL on a non-8000 port', () => {
    const source = 'const url = `${apiBase}/p/${externalId}/3000/preview`;';

    expect(rules(source)).toContain('runtime-proxy-url');
  });

  test('flags a hand-built proxy URL whose port is interpolated', () => {
    const source = 'const url = `${base}/v1/p/${encodeURIComponent(sandboxId)}/${port}`;';

    expect(rules(source)).toContain('runtime-proxy-url');
  });

  test('flags a hand-built proxy URL whose port is followed by a path interpolation', () => {
    const source = 'const url = `${base}/v1/p/${opts.sandboxId}/${opts.port}${path}`;';

    expect(rules(source)).toContain('runtime-proxy-url');
  });

  test('does not flag prose that spells the proxy URL out', () => {
    const source = ' *   https://<host>/v1/p/<external-id>/8000\n';

    expect(scanSource(source)).toEqual([]);
  });
});

describe('scanSource import rules', () => {
  test('flags a deep @kortix/sdk source import', () => {
    const source = "import { y } from '@kortix/sdk/src/core/rest/client';";

    expect(rules(source)).toContain('sdk-internal-import');
  });

  test('flags a relative reach into packages/sdk/src', () => {
    const source = "import { y } from '../../../../packages/sdk/src/core/rest/client';";

    expect(rules(source)).toContain('sdk-internal-import');
  });

  test('flags a deep @kortix/sdk source import inside a test file', () => {
    const source = "import { y } from '@kortix/sdk/src/core/rest/client';";

    expect(rules(source, { test: true })).toEqual(['sdk-internal-import']);
  });

  test('allows the public @kortix/sdk entry point', () => {
    const source = "import { createKortix } from '@kortix/sdk';";

    expect(scanSource(source)).toEqual([]);
  });

  test('allows the public @kortix/sdk/server entry point', () => {
    const source = "import { createKortix } from '@kortix/sdk/server';";

    expect(scanSource(source)).toEqual([]);
  });
});

describe('TRANSPORT_ALLOWLIST', () => {
  test('exempts the SDK adapter', () => {
    expect(TRANSPORT_ALLOWLIST).toContain('src/api/sdk.ts');
  });

  test('holds exactly one escape hatch', () => {
    expect(TRANSPORT_ALLOWLIST).toHaveLength(1);
  });
});

describe('scanCliBoundary', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test('reports a planted raw Kortix fetch with its file and line', () => {
    root = mkdtempSync(resolve(tmpdir(), 'kortix-cli-sdk-boundary-'));
    writeFileSync(
      resolve(root, 'planted.ts'),
      [
        'export async function listProjects(base: string) {',
        '  return fetch(`${base}/v1/workspaces`);',
        '}',
        '',
      ].join('\n'),
    );

    const violations = scanCliBoundary(root);

    expect(violations).toEqual([
      {
        rule: 'raw-kortix-fetch',
        index: expect.any(Number),
        match: 'fetch(',
        message: expect.stringContaining('src/api/sdk.ts'),
        file: 'planted.ts',
        line: 2,
      },
    ]);
  });

  test('reports no violation for a planted allow-listed fetch', () => {
    root = mkdtempSync(resolve(tmpdir(), 'kortix-cli-sdk-boundary-'));
    writeFileSync(
      resolve(root, 'clean.ts'),
      [
        "import { createKortix } from '@kortix/sdk';",
        'export async function latest() {',
        "  return fetch('https://api.github.com/repos/kortix-ai/CompanyOS/releases/latest');",
        '}',
        'export { createKortix };',
        '',
      ].join('\n'),
    );

    expect(scanCliBoundary(root)).toEqual([]);
  });
});
