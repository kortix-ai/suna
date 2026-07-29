import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const workflow = read('.github/workflows/package-tests.yml');
const testScript = read('apps/api/scripts/test.sh');
const envTest = read('apps/api/scripts/test.env');

const apiJob = workflow.slice(workflow.indexOf('\n  api:'));

describe('the kortix-api suite actually runs on pull requests', () => {
  test('no step in the api job is gated on a secret being present', () => {
    const gated = apiJob
      .split('\n')
      .filter((line) => /^\s+if:/.test(line))
      .filter((line) => /secrets\.|env\.[A-Z0-9_]+\s*[=!]=/.test(line));
    expect(gated).toEqual([]);
  });

  test('the api job never receives the dotenvx master key', () => {
    expect(apiJob).not.toContain('DOTENV_PRIVATE_KEY:');
  });

  test('the unit suite runs off the committed fake env, not dotenvx', () => {
    const runLine = testScript.split('\n').find((line) => line.trim().startsWith('exec bun test'));
    expect(runLine).toContain('--env-file=scripts/test.env');
    expect(runLine).not.toContain('dotenvx');
  });

  test('a suite that discovers no files refuses to report success', () => {
    expect(testScript).toContain('KORTIX_MIN_TEST_FILES');
    expect(testScript).toContain('exit 1');
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
