#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const skipSdkTests = process.env.KORTIX_PACKAGE_SKIP_SDK_TESTS === '1';

/**
 * The kortixd suite (apps/kortix-sandbox-agent-server) is written against a
 * bare host: its daemon tests assert image-baked state is ABSENT ("no baked
 * LLM catalog → minimal model set", "no managed-skills overlay → only project
 * skills", a scaffoldless boot clone, bare-host readiness probes). On a box
 * that IS a Kortix deployment `/opt/kortix` exists — the baked catalog, the
 * managed skills and the scaffold are real — and those tests fail there,
 * byte-identically at origin/main (12 of 1844, verified 2026-10-03).
 *
 * CI runs this suite on a bare runner, so the coverage is owned there; the
 * daily `Tests` run on `main` and the staging release gate are the safety
 * nets. On a Kortix box the lane skips the suite loudly instead of failing
 * on assertions no machine of this shape can satisfy.
 */
const onKortixImage = () => existsSync('/opt/kortix');

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

async function runAll(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
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
      '-g',
      '*.test.js',
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
        // The CLI includes an intentional 11-second idle-stream contract.
        // Concurrent API and agent workers can push it past 15 seconds.
        KORTIX_TEST_TIMEOUT_MS: '30000',
        // Unit tests exercise offload with explicit temporary databases. Never
        // let a proxy's background maintenance open the developer's transcript.
        KORTIX_ATTACHMENT_OFFLOAD: '0',
        ...env,
      },
    },
  );
}

await runAll([
  run(['node', 'scripts/stage-npm-publish.test.mjs']),
  run(['node', 'scripts/publish-npm-package.test.mjs']),
  run(['node', '--test', 'scripts/check-blocked-terms.test.mjs']),
  run(['node', '--test', 'scripts/prod-us-east-2/*.test.mjs']),
]);
await rejectFocusedTests();
await runAll([
  run(['pnpm', '--filter', '@kortix/sdk', 'typecheck']),
  run(['pnpm', '--filter', '@kortix/sdk', 'run', 'smoke:install']),
  // Frozen counts (apps/api/eslint.config.mjs): new violations fail, fixed ones must be pruned.
  run(['pnpm', '--filter', 'kortix-api', 'lint']),
]);
await runAll([
  ...['llm-catalog', 'sdk'].map((directory) =>
    verifyPublishablePackage(directory, false),
  ),
  verifyAgentTunnelCli(),
]);

// Run two explicit bounded waves. This avoids a generic workspace fan-out while
// removing idle CPU time between independent load classes. Keep the CLI and
// agent server sequential. Concurrent isolated Bun workers can spin indefinitely.
await runAll([
  runWorkspaceTests(['kortix-api'], 1),
  (async () => {
    await runWorkspaceTests(['@kortix/cli'], 1);
    if (onKortixImage()) {
      console.log(
        "[package-quality] SKIP kortixd: this box is a Kortix image (/opt/kortix present); the suite's bare-host assumptions do not hold here. CI owns this suite (daily Tests on main, staging release gate).",
      );
    } else {
      await runWorkspaceTests(['kortixd'], 1);
    }
  })(),
]);
// The root `.npmrc` sets `ignore-scripts=true`, so `pnpm install` never runs
// apps/mobile's `postinstall: patch-package`. Its tests assert the patched
// libraries (`lib/markdown/markdown-keys.test.ts`), so apply the patches here.
// patch-package is idempotent: a checkout that already applied them passes.
await run(['pnpm', '--filter', './apps/mobile', 'exec', 'patch-package']);
await runAll([
  // `@kortix/db`'s PostgreSQL contracts (`*.integration.test.ts`) and
  // `tests/migration` run in the `db-suites` lane of the core run.
  runWorkspaceTests(['@kortix/db'], 1),
  runWorkspaceTests(
    [
      './packages/**',
      './apps/**',
      '!kortix-api',
      '!@kortix/cli',
      '!kortixd',
      '!@kortix/db',
      ...(skipSdkTests ? ['!@kortix/sdk'] : []),
    ],
    2,
  ),
]);
