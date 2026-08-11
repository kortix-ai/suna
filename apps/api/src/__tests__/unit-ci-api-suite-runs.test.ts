import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const workflow = read('.github/workflows/tests.yml');
const packageQuality = read('tests/bin/package-quality.ts');
const testScript = read('apps/api/scripts/test.sh');
const envTest = read('apps/api/scripts/test.env');
const packageJson = JSON.parse(read('apps/api/package.json')) as {
  scripts: Record<string, string>;
};

const sandboxJob = workflow.slice(workflow.indexOf('\n  sandbox:'));

describe('the kortix-api suite actually runs on pull requests', () => {
  test('the reusable workflow runs every root lane on exact-SHA sandbox workers', () => {
    expect(sandboxJob).toContain('matrix:');
    expect(sandboxJob).toContain('- lane: core');
    expect(sandboxJob).toContain('- lane: browser-1');
    expect(sandboxJob).toContain('- lane: browser-2');
    expect(sandboxJob).toContain('- lane: packages');
    expect(sandboxJob).toContain('core) bun tests/bin/sandbox-ci.ts ;;');
    expect(sandboxJob).toContain(
      'browser-1) bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=1/2 ;;',
    );
    expect(sandboxJob).toContain(
      'browser-2) bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=2/2 ;;',
    );
    expect(sandboxJob).toContain('packages)');
    expect(sandboxJob).toContain('export KORTIX_PACKAGE_SKIP_SDK_TESTS=1');
    expect(sandboxJob).toContain('bun tests/bin/sandbox-ci.ts --packages-only');
    expect(sandboxJob).toContain('SANDBOX_TEST_SHA:');
    expect(sandboxJob).toContain('SANDBOX_TEST_REF:');
    expect(sandboxJob).toContain('TEST_SANDBOX_PROVIDER:');
  });

  test('the sandbox job never receives the dotenvx master key', () => {
    expect(sandboxJob).not.toContain('DOTENV_PRIVATE_KEY:');
  });

  test('the sandbox job has an independent provider-neutral cleanup step', () => {
    expect(sandboxJob).toContain('if: always()');
    expect(sandboxJob).toContain('bun tests/bin/sandbox-ci-cleanup.ts');
  });

  test('full mode reaches every package and app test through package-quality', () => {
    expect(packageQuality).toContain("'./packages/**'");
    expect(packageQuality).toContain("'./apps/**'");
    expect(packageQuality).toContain("KORTIX_TEST_TIMEOUT_MS: '30000'");
  });

  test('the unit suite runs off the committed fake env, not dotenvx', () => {
    const runLine = testScript.split('\n').find((line) => line.trim().startsWith('exec bun test'));
    expect(runLine).toContain('--env-file=scripts/test.env');
    expect(runLine).not.toContain('dotenvx');
  });

  test('the dev process does not reload .env after dotenvx injects launch overrides', () => {
    expect(packageJson.scripts.dev).toContain('bun --no-env-file run --hot src/index.ts');
  });

  test('a suite that discovers no files refuses to report success', () => {
    expect(testScript).toContain('KORTIX_MIN_TEST_FILES');
    expect(testScript).toContain('exit 1');
  });

  test('the package timeout preserves each package default outside the loaded package lane', () => {
    expect(testScript).toContain('KORTIX_TEST_TIMEOUT_MS:-15000');
  });

  test('the committed fixture carries no ciphertext and no live-looking credential', () => {
    const values = envTest
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.slice(line.indexOf('=') + 1));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      // The pre-commit secrets guard auto-encrypts `.env*`; if this fixture is
      // ever renamed back under that pattern it lands in CI as ciphertext and
      // every test dies at config validation. Catch it here instead.
      expect(value).not.toContain('encrypted:');
      expect(value).not.toMatch(/\b(sk|pk|rk|whsec|eyJ|ghp|github_pat|dtn|xox)[-_a-zA-Z0-9]/);
    }
  });
});
