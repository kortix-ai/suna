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

const laneJob = workflow.slice(workflow.indexOf('\n  lane:'));

describe('the kortix-api suite actually runs on pull requests', () => {
  test('the reusable workflow runs every root lane natively at the exact PR head SHA', () => {
    expect(laneJob).toContain('matrix:');
    expect(laneJob).toContain('- lane: core');
    expect(laneJob).toContain('- lane: browser-1');
    expect(laneJob).toContain('- lane: browser-2');
    expect(laneJob).toContain('- lane: packages');
    expect(laneJob).toContain('args: --browser-only --browser-shard=1/2');
    expect(laneJob).toContain('args: --browser-only --browser-shard=2/2');
    expect(laneJob).toContain('args: --packages-only');
    expect(laneJob).toContain('if [[ -n "$TEST_ARGS" ]]; then pnpm test -- $TEST_ARGS; else pnpm test; fi');
    expect(laneJob).toContain('export KORTIX_PACKAGE_SKIP_SDK_TESTS=1');
    expect(laneJob).toContain('TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(laneJob).toContain('ref: ${{ env.TEST_SHA }}');
  });

  test('the lane job never receives the dotenvx master key', () => {
    expect(laneJob).not.toContain('DOTENV_PRIVATE_KEY:');
  });

  test('the lane job always stops its local Supabase and always uploads results', () => {
    expect(laneJob).toContain("if: always() && matrix.mode == 'browser'");
    expect(laneJob).toContain('pnpm exec supabase stop --no-backup || true');
    expect(laneJob).toContain('actions/upload-artifact@v7');
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
