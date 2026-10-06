#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const skipSdkTests = process.env.KORTIX_PACKAGE_SKIP_SDK_TESTS === '1';

/**
 * Runner controls that must survive the hermetic scrub below.
 *
 * A Kortix-managed sandbox exports the agent session's own identity into the
 * environment (KORTIX_TOKEN, KORTIX_PROJECT_ID, KORTIX_SUPERVISED, …) and
 * writes it to /dev/shm/kortix/agent-env.sh, which the CLI reads through
 * `sandboxEnvValue()`. Workspace suites inherit that identity and then fail
 * on tests that need a CI-shaped env (a compiled runtime rejects a foreign
 * KORTIX_PROJECT_ID; a supervised box refuses binary downloads; a direct
 * KORTIX_REPO_URL is refused). On a laptop or a GitHub runner none of these
 * vars exist, so dropping them here reproduces exactly what CI sees. Suites
 * that need a value set it themselves (apps/api/scripts/test.env, per-test
 * setup); the Kortix-shared `sandboxEnvValue()` path is cut off with
 * KORTIX_DISABLE_SANDBOX_ENV_FILE=1, matching the flag every spawn harness
 * in the repo already sets.
 */
const RUNNER_CONTROLS = new Set([
  'KORTIX_API_TEST_WORKERS',
  'KORTIX_MIN_TEST_FILES',
  'KORTIX_PACKAGE_SKIP_SDK_TESTS',
]);

function hermeticWorkspaceEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('KORTIX_') && !RUNNER_CONTROLS.has(name)) continue;
    // The session also exports BASH_ENV=/dev/shm/kortix/agent-env.sh. A bash
    // script started while the stack under test has written that file sources
    // it at startup and injects the host's project identity into every test
    // worker (the compiled-runtime identity checks then fail on the ambient
    // value). Dropping it here reproduces CI, where BASH_ENV is unset.
    if (name === 'BASH_ENV') continue;
    env[name] = value;
  }
  env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  // The platform points BASH_ENV at its agent-env file; every bash a lane
  // spawns (apps/api/scripts/test.sh) would source it and re-export the
  // ambient platform env right back. ENV covers the same hook for /bin/sh.
  delete env.BASH_ENV;
  delete env.ENV;
  // The same CI-shape rule for the two host files a Kortix sandbox image bakes:
  // the session env file the daemon's readiness gate reads, and the image's
  // baked model catalog. Neither exists on a laptop or a GitHub runner, so the
  // suites are written against their absence; point the overrides at paths
  // that do not exist instead of asking every suite to know about them.
  env.KORTIX_PT_ENV_PATH = '/nonexistent/kortix-test-pt-env';
  env.KORTIX_BAKED_LLM_CATALOG_PATH = '/nonexistent/kortix-test-llm-catalog.json';
  // Same rule for the image's baked managed-skills dir: suites assert the
  // exact skill lists their fixtures create, and CI has no baked dir.
  env.KORTIX_MANAGED_SKILLS_DIR = '/nonexistent/kortix-test-managed-skills';
  // bash re-reads BASH_ENV (sh: ENV) on every startup and re-exports the
  // sandbox session identity behind this scrub — a Kortix sandbox image sets
  // it to the daemon's agent-env file, which carries KORTIX_PROJECT_ID and
  // breaks identity-checked child processes (compiled runtimes). CI exports
  // neither variable.
  delete env.BASH_ENV;
  delete env.ENV;
  return env;
}

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
        ...hermeticWorkspaceEnv(),
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
  run(['node', '--test', 'scripts/dev-local.test.mjs']),
  run(['node', '--test', 'scripts/prod-us-east-2/*.test.mjs']),
]);
await rejectFocusedTests();
// apps/web's download-layout test launches Playwright Chromium. CI installs
// the browser in the workflow before this lane; a worker sandbox that runs the
// lane bare does not, and the test then fails with "Executable doesn't exist".
// `playwright install` is idempotent (near-instant when the browser is
// present) and honors PLAYWRIGHT_BROWSERS_PATH, so a CI cache still hits.
await run(['pnpm', '--dir', 'tests', 'run', 'playwright:install']);
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
    await runWorkspaceTests(['kortixd'], 1);
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
// apps/kortix-worker sits outside the pnpm workspace (own bun.lock, supply-chain
// cooldown), so the workspace fan-out above cannot reach it. Install its deps
// the way the sandbox-agent job does in ci.yml, then run its tests here — no
// lane ran them before this.
await run(['bun', 'install', '--frozen-lockfile'], { cwd: resolve(root, 'apps/kortix-worker') });
await run(['bun', 'test', 'src/'], { cwd: resolve(root, 'apps/kortix-worker') });
