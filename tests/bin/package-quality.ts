#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  console.log(`[package-quality] ${command.join(' ')}`);
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited with code ${code}`);
}

async function rejectFocusedTests(): Promise<void> {
  const child = Bun.spawn(
    [
      'rg',
      '-n',
      String.raw`\b(describe|test|it)\.only\(`,
      'apps',
      'packages',
      '-g',
      '*.test.ts',
      '-g',
      '*.test.tsx',
      '-g',
      '*.test.mts',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code === 1) return;
  if (code !== 0) throw new Error(`focused-test scan exited with code ${code}`);
  process.stderr.write(output);
  throw new Error('focused test (.only) committed');
}

async function verifyPublishablePackage(directory: string, build = true): Promise<void> {
  const packageDirectory = resolve(root, 'packages', directory);
  const packagePath = resolve(packageDirectory, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const parsed = JSON.parse(original) as {
    name: string;
    scripts?: Record<string, string>;
  };
  const buildScript = parsed.scripts?.['build:bundles'] ? 'build:bundles' : 'build';

  if (build) await run(['pnpm', '--filter', parsed.name, 'run', buildScript]);
  try {
    await run(['node', '../../scripts/stage-npm-publish.mjs'], {
      cwd: packageDirectory,
      env: { ...process.env, VERSION: '0.0.0-local-test' },
    });
    await run(['npm', 'pack', '--dry-run'], { cwd: packageDirectory });
  } finally {
    await writeFile(packagePath, original);
  }
}

async function verifyAgentTunnelCli(): Promise<void> {
  await verifyPublishablePackage('agent-tunnel');
  const cli = resolve(root, 'packages/agent-tunnel/dist/agent-cli.js');
  const help = await Bun.$`node ${cli} help`.text();
  for (const expected of [
    'connect',
    'run',
    'install-service',
    'service-status',
    'uninstall-service',
    '--daemon',
    '--foreground',
  ]) {
    if (!help.includes(expected)) {
      throw new Error(`packed agent-tunnel CLI help is missing ${expected}`);
    }
  }
  if (help.includes('--keep-awake')) {
    throw new Error('packed agent-tunnel CLI exposes removed --keep-awake flag');
  }

  const fallback = Bun.spawn(
    [
      'node',
      '--input-type=module',
      '-e',
      `delete globalThis.WebSocket; process.argv[2] = "help"; await import(${JSON.stringify(cli)})`,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  const fallbackHelp = await new Response(fallback.stdout).text();
  const fallbackCode = await fallback.exited;
  if (fallbackCode !== 0 || !fallbackHelp.includes('install-service')) {
    throw new Error('packed agent-tunnel CLI cannot load its WebSocket fallback');
  }
}

async function runWorkspaceTests(
  filters: string[],
  workspaceConcurrency: number,
  env: Record<string, string> = {},
): Promise<void> {
  await run(
    [
      'pnpm',
      `--workspace-concurrency=${workspaceConcurrency}`,
      '--no-sort',
      ...filters.flatMap((filter) => ['--filter', filter]),
      '--if-present',
      'test',
    ],
    {
      env: {
        ...process.env,
        KORTIX_TEST_TIMEOUT_MS: '15000',
        ...env,
      },
    },
  );
}

await run(['node', 'scripts/stage-npm-publish.test.mjs']);
await run(['node', 'scripts/publish-npm-package.test.mjs']);
await rejectFocusedTests();
await run(['pnpm', '--filter', '@kortix/sdk', 'typecheck']);
await run(['pnpm', '--filter', '@kortix/sdk', 'run', 'smoke:install']);
for (const directory of ['llm-catalog', 'sdk', 'executor-sdk']) {
  await verifyPublishablePackage(directory, false);
}
await verifyAgentTunnelCli();

// Keep process-heavy suites in explicit load classes. A generic workspace fan-out
// makes their internal worker pools compete and breaks the repository's 5-second
// performance contracts. The lanes still parallelize within each package.
await runWorkspaceTests(['kortix-api'], 1, {
  // Full mode runs beside the local product stack. Three isolated workers keep
  // process-heavy Git tests inside their fixed 15-second performance contract.
  KORTIX_API_TEST_WORKERS: '3',
});
await runWorkspaceTests(['@kortix/cli', '@kortix/sandbox-agent-server'], 2);
await runWorkspaceTests(['@kortix/db'], 1);
await runWorkspaceTests(
  [
    './packages/**',
    './apps/**',
    '!kortix-api',
    '!@kortix/cli',
    '!@kortix/sandbox-agent-server',
    '!@kortix/db',
  ],
  2,
);
