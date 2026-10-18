#!/usr/bin/env node
// Prefix of every workspace package `test` script:
//   "test": "node ../../scripts/test-guard.mjs \"<real command>\""
// pnpm appends the caller's arguments after the quoted command, so they are
// argv[3..]. A Mac runs targeted tests only: with no file or name filter the
// guard refuses the whole package suite. CI and Linux boxes are never refused.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function refuses(args, platform, env) {
  if (platform !== 'darwin' || env.KORTIX_FULL_TEST === '1') return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  const targeted = args.some(
    (arg) => !arg.startsWith('-') || arg === '-t' || arg.startsWith('--test-name-pattern'),
  );
  return !targeted;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  // KORTIX_TEST_GUARD_PLATFORM: tests only, to prove the Linux path on a Mac.
  if (refuses(args, process.env.KORTIX_TEST_GUARD_PLATFORM || process.platform, process.env)) {
    const pkg = process.env.npm_package_name || '<pkg>';
    console.error(
      `refused: whole ${pkg} suite on a Mac; pass the test file(s): pnpm --filter ${pkg} test <file>  (KORTIX_FULL_TEST=1 overrides)`,
    );
    process.exit(2);
  }
  const run = spawnSync('sh', ['-c', `${command} "$@"`, 'sh', ...args], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
