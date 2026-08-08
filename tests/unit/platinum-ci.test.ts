import { describe, expect, test } from 'vitest';
import {
  PLATINUM_CI_BUN_VERSION,
  PLATINUM_CI_NODE_IMAGE,
  PLATINUM_CI_PNPM_VERSION,
  buildPlatinumTemplateSpec,
  buildWorkerScript,
  platinumTemplateName,
  validatePlatinumCiInput,
} from '../src/core/platinum-ci';

const sha = 'a'.repeat(40);
const lockHash = 'b'.repeat(64);

describe('Platinum CI worker plan', () => {
  test('uses one content-addressed template for one lockfile', () => {
    expect(platinumTemplateName(lockHash)).toBe('kortix-ci-v2-bbbbbbbbbbbbbbbb');
    const spec = buildPlatinumTemplateSpec({
      lockHash,
      repository: 'kortix-ai/suna',
      cacheSha: sha,
    });

    expect(spec.name).toBe(platinumTemplateName(lockHash));
    expect(spec.base_image).toBe(PLATINUM_CI_NODE_IMAGE);
    expect(spec.default_cpu).toBe(8);
    expect(spec.default_ram_mb).toBe(16_384);
    expect(spec.default_disk_gb).toBe(50);
    expect(JSON.stringify(spec.steps)).toContain(`bun@${PLATINUM_CI_BUN_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`pnpm@${PLATINUM_CI_PNPM_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`fetch --depth=1 origin ${sha}`);
    expect(JSON.stringify(spec.steps)).toContain('playwright install chromium');
    for (const step of spec.steps) {
      if (step.op === 'run') expect(step.cmd).not.toContain('\n');
    }
  });

  test('checks out the requested ref and rejects any SHA mismatch', () => {
    const script = buildWorkerScript({
      repository: 'kortix-ai/suna',
      ref: 'refs/pull/6260/head',
      sha,
      testArgs: ['--full'],
    });

    expect(script).toContain("'pnpm' 'test' '--' '--full'");
    expect(script).toContain("fetch --depth=1 origin 'refs/pull/6260/head'");
    expect(script).toContain(`if [[ "$actual_sha" != '${sha}' ]]`);
    expect(script).toContain('nohup pnpm dev');
    expect(script).toContain('tar -C "$ROOT" -czf "$ARTIFACT" tests/test-results');
  });

  test('does not start the web stack for the default core run', () => {
    const script = buildWorkerScript({
      repository: 'kortix-ai/suna',
      ref: sha,
      sha,
      testArgs: [],
    });

    expect(script).toContain("'pnpm' 'test'");
    expect(script).not.toContain('nohup pnpm dev');
  });

  test('rejects values that could alter the Git fetch command', () => {
    expect(() =>
      validatePlatinumCiInput({
        apiUrl: 'https://api.platinum.dev',
        apiKey: 'test',
        repository: 'kortix-ai/suna',
        sha,
        ref: 'main; curl attacker',
        runId: '1',
        runAttempt: '1',
        testArgs: [],
        root: '/tmp/suna',
      }),
    ).toThrow(/invalid Git ref/);
  });
});
