import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runProviderCase(input: {
  provider: string;
  flags: string[];
  expectedLines: string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), `kortix-connector-${input.provider}-`));
  tempDirectories.push(directory);
  const manifestPath = join(directory, 'kortix.yaml');
  const prefix = 'kortix_version: 2\n# preserve this comment\nname: Provider matrix\n';
  await writeFile(manifestPath, prefix, 'utf8');

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      CLI_ENTRY,
      'connectors',
      'add',
      `${input.provider}-tools`,
      '--provider',
      input.provider,
      ...input.flags,
    ],
    cwd: directory,
    env: {
      ...process.env,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(directory, 'config.json'),
      KORTIX_TOKEN: undefined,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const manifest = await readFile(manifestPath, 'utf8');

  expect(code).toBe(0);
  expect(stdout).toContain(`Added [[connectors]] ${input.provider}-tools`);
  expect(stderr).toBe('host cloud (https://api.kortix.com, not logged in)\n');
  expect(manifest.startsWith(prefix)).toBe(true);
  expect(manifest).toContain(`slug: ${input.provider}-tools`);
  expect(manifest).toContain(`provider: ${input.provider}`);
  for (const line of input.expectedLines) expect(manifest).toContain(line);
}

describe('kortix connectors add provider matrix', () => {
  const cases = [
    {
      provider: 'pipedream',
      flags: ['--app', 'github'],
      expectedLines: ['app: github'],
    },
    {
      provider: 'mcp',
      flags: ['--url', 'https://mcp.example.test', '--transport', 'http'],
      expectedLines: ['url: https://mcp.example.test', 'transport: http'],
    },
    {
      provider: 'openapi',
      flags: ['--spec', 'https://api.example.test/openapi.json'],
      expectedLines: ['spec: https://api.example.test/openapi.json'],
    },
    {
      provider: 'postman',
      flags: ['--spec', 'https://github.com/example/postman'],
      expectedLines: ['spec: https://github.com/example/postman'],
    },
    {
      provider: 'graphql',
      flags: ['--endpoint', 'https://api.example.test/graphql'],
      expectedLines: ['endpoint: https://api.example.test/graphql'],
    },
    {
      provider: 'http',
      flags: ['--base-url', 'https://api.example.test'],
      expectedLines: ['base_url: https://api.example.test'],
    },
  ];

  for (const input of cases) {
    test(`${input.provider} writes the provider-specific manifest fields`, async () => {
      await runProviderCase(input);
    });
  }
});
