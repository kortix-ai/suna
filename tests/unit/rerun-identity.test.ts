/**
 * A re-run must not collide with its own first attempt.
 *
 * `github.run_id` is IDENTICAL across attempts of the same workflow run, and the
 * release gate seeds every run-scoped fixture name from it
 * (`principals.ts` names principals `e2e-<runId>-…`). So `gh run rerun --failed`
 * used to re-derive names attempt 1 had already claimed: run 32330628092
 * attempt 2 failed KAAB-7 in 2.2s with
 * `{"error":"Idempotency key is already in use","code":"IDEMPOTENCY_KEY_CONFLICT"}`
 * on its very first `POST /sessions` — a passing flow reported as a failure, on
 * the release gate, mid-release. Re-run is the cheapest recovery lever the gate
 * has; it has to be trustworthy.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { runAttemptSuffix } from '../src/core/run-identity';

const root = resolve(import.meta.dirname, '../..');
const releaseWorkflow = readFileSync(
  resolve(root, '.github/workflows/tests-release.yml'),
  'utf8',
);

describe('runAttemptSuffix', () => {
  test('is empty on the first attempt, so existing ids are unchanged', () => {
    expect(runAttemptSuffix({})).toBe('');
    expect(runAttemptSuffix({ GITHUB_RUN_ATTEMPT: '1' })).toBe('');
  });

  test('namespaces every attempt after the first', () => {
    expect(runAttemptSuffix({ GITHUB_RUN_ATTEMPT: '2' })).toBe('-a2');
    expect(runAttemptSuffix({ GITHUB_RUN_ATTEMPT: '11' })).toBe('-a11');
  });

  test('a malformed attempt degrades to no suffix rather than a junk namespace', () => {
    expect(runAttemptSuffix({ GITHUB_RUN_ATTEMPT: '' })).toBe('');
    expect(runAttemptSuffix({ GITHUB_RUN_ATTEMPT: 'nope' })).toBe('');
  });
});

describe('release gate run identity', () => {
  test('the pinned shard run id carries the attempt', () => {
    expect(releaseWorkflow).toContain(
      "KE2E_RUN_ID: ${{ github.run_id }}-api${{ matrix.shard }}${{ github.run_attempt != 1 && format('-a{0}', github.run_attempt) || '' }}",
    );
  });

  test('the reclaim sweep reuses that exact variable, so it stays scoped', () => {
    // If the sweep re-derived the id instead of reading KE2E_RUN_ID, a re-run
    // would rename the world out from under its own `if: always()` reclaim and
    // leak every principal it created.
    expect(releaseWorkflow).toContain('bun tests/bin/ke2e.ts gc --run-id "$KE2E_RUN_ID"');
  });
});
