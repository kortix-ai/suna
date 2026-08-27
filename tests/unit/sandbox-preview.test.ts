import { describe, expect, it, vi } from 'vitest';
import {
  PreviewInfrastructureError,
  buildPreviewBootstrapScript,
  previewLockfileHash,
  previewSandboxIdentity,
  previewSandboxName,
  runSandboxPreview,
  selectStalePreviewSandboxIds,
} from '../src/core/sandbox-preview';
import {
  daytonaPreviewLabelsFilter,
  platinumPreviewIdempotencyKey,
} from '../src/core/sandbox-preview-providers';

const input = {
  provider: 'auto' as const,
  prNumber: 6337,
  repository: 'kortix-ai/suna',
  sha: 'a'.repeat(40),
};

describe('provider-neutral preview lifecycle', () => {
  it('uses one stable sandbox name per pull request', () => {
    expect(previewSandboxName(6337)).toBe('kortix-preview-pr-6337');
  });

  it('gives a pull request preview a disposable identity and a branch environment a standing one', () => {
    expect(previewSandboxIdentity({ prNumber: 6337 })).toEqual({
      name: 'kortix-preview-pr-6337',
      owner: 'kortix-preview',
      autoArchiveDays: 7,
      autoDeleteDays: 7,
      reuseExisting: false,
    });
    expect(previewSandboxIdentity({ prNumber: 6998, branchEnv: 'pi-worker' })).toEqual({
      name: 'kortix-env-pi-worker',
      owner: 'kortix-branch-env',
      autoArchiveDays: 0,
      autoDeleteDays: 0,
      reuseExisting: true,
    });
  });

  it('names a branch environment after the branch, not the pull request that carries it', () => {
    // The whole point is a URL that survives a push, so the PR number must not
    // reach the name — two deploys of one branch have to land on one sandbox.
    const first = previewSandboxIdentity({ prNumber: 1, branchEnv: 'feat/Pi_Worker' });
    const second = previewSandboxIdentity({ prNumber: 999, branchEnv: 'feat/Pi_Worker' });
    expect(first.name).toBe(second.name);
    expect(first.name).toBe('kortix-env-feat-pi-worker');
    expect(() => previewSandboxIdentity({ prNumber: 1, branchEnv: '///' })).toThrow(
      /invalid branch for a persistent environment/,
    );
  });

  it('runs the suite in a pull request preview and skips it in a branch environment', () => {
    const base = {
      repository: 'kortix-ai/suna',
      ref: 'pi-worker',
      sha: 'a'.repeat(40),
      prNumber: 6998,
      origin: 'https://x.example.test',
    };
    // Match the executed LINE: the skip branch names the command in a hint, so
    // a substring check would report it as running.
    const executesSuite = (script: string) =>
      script.split('\n').some((line) => line.trim() === 'pnpm test -- --target-full');

    expect(executesSuite(buildPreviewBootstrapScript(base))).toBe(true);
    expect(executesSuite(buildPreviewBootstrapScript({ ...base, runTests: true }))).toBe(true);
    expect(executesSuite(buildPreviewBootstrapScript({ ...base, runTests: false }))).toBe(false);

    // Skipping the suite must not skip the proof that the stack came up on
    // this commit — that check is what the deploy is actually gated on.
    for (const runTests of [true, false]) {
      expect(buildPreviewBootstrapScript({ ...base, runTests })).toContain('/v1/health');
    }
  });

  it('health-checks the stack locally, never through the public name', () => {
    // The public name is served by a proxy that is only re-pointed at this
    // sandbox AFTER the deploy returns. Checking through it would deadlock the
    // first deploy, and on later ones would be answered by the PREVIOUS
    // sandbox — reporting success for a stack that never came up.
    const script = buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'pi-worker',
      sha: 'a'.repeat(40),
      prNumber: 6998,
      origin: 'https://pi.example.test',
      runTests: false,
    });
    expect(script).toContain('HEALTH=http://127.0.0.1:8080/v1/health');
    expect(script).not.toContain('https://pi.example.test/v1/health');
    // The stack is still CONFIGURED with the public origin — that is what ends
    // up in SITE_URL, the redirect allowlist and the frontend's own URLs.
    expect(script).toContain("PREVIEW_ORIGIN='https://pi.example.test'");
  });

  it('keeps branch environments out of the nightly sweep', () => {
    // A branch environment has no pull request to close, so the reconciler must
    // never see it as stale. It is excluded by OWNER, not by an expiry date.
    const stale = selectStalePreviewSandboxIds(
      [
        { id: 'closed-pr', metadata: { owner: 'kortix-preview', pr_number: '4242', git_sha: 'a' } },
        { id: 'branch-env', metadata: { owner: 'kortix-branch-env', pr_number: '6998', git_sha: 'b' } },
      ],
      new Map<number, string>(),
    );
    expect(stale).toEqual(['closed-pr']);
  });

  it('uses a new Platinum idempotency key for each deployment run', () => {
    expect(
      platinumPreviewIdempotencyKey({
        prNumber: 6337,
        sha: 'a'.repeat(40),
        runId: '31431634153',
      }),
    ).toBe(`kortix-preview-6337-${'a'.repeat(40)}-31431634153`);
    expect(
      platinumPreviewIdempotencyKey({
        prNumber: 6337,
        sha: 'a'.repeat(40),
        runId: '31428940308',
      }),
    ).not.toBe(
      platinumPreviewIdempotencyKey({
        prNumber: 6337,
        sha: 'a'.repeat(40),
        runId: '31431634153',
      }),
    );
  });

  it('encodes the Daytona preview ownership filter as JSON', () => {
    expect(daytonaPreviewLabelsFilter()).toBe('{"kortix-preview":"true"}');
  });

  it('requires the exact SHA-256 of the pull request lockfile', () => {
    expect(previewLockfileHash('A'.repeat(64))).toBe('a'.repeat(64));
    expect(() => previewLockfileHash('a'.repeat(40))).toThrow('64 hex characters');
  });

  it('boots the exact self-host distribution and runs the canonical deployed suite', () => {
    const script = buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'refs/pull/6337/head',
      sha: 'a'.repeat(40),
      prNumber: 6337,
      origin: 'https://preview.example',
    });
    expect(script).toContain('git -C "$ROOT" checkout --detach --force FETCH_HEAD');
    expect(script).toContain('test "$actual_sha" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(script).toContain('apps/cli/src/index.ts self-host init');
    expect(script).toContain('tests/bin/preview-stack.ts');
    expect(script).toContain('docker compose');
    expect(script).toContain('for stack_attempt in 1 2; do');
    expect(script).toMatch(/if docker compose .* up -d --wait --wait-timeout 300; then/);
    expect(script).toContain('test "$stack_attempt" -lt 2');
    expect(script).toContain('pnpm test -- --target-full');
    expect(script).toContain('/workspace/kortix-test-results.tar.gz');
    expect(script).toContain('kortix-preview.exit');
    expect(script).not.toContain('ecs-preview');
  });

  it('falls back only after a Platinum infrastructure failure', async () => {
    const platinum = vi.fn().mockRejectedValue(new PreviewInfrastructureError('restore timeout'));
    const daytona = vi.fn().mockResolvedValue({ exitCode: 0, provider: 'daytona' });
    await expect(runSandboxPreview(input, { platinum, daytona })).resolves.toEqual({
      exitCode: 0,
      provider: 'daytona',
    });
    expect(daytona).toHaveBeenCalledOnce();
  });

  it('does not fall back after a product test failure', async () => {
    const platinum = vi.fn().mockResolvedValue({ exitCode: 9, provider: 'platinum' });
    const daytona = vi.fn();
    await expect(runSandboxPreview(input, { platinum, daytona })).resolves.toEqual({
      exitCode: 9,
      provider: 'platinum',
    });
    expect(daytona).not.toHaveBeenCalled();
  });

  it('does not hide an arbitrary controller bug behind fallback', async () => {
    const platinum = vi.fn().mockRejectedValue(new Error('invalid preview config'));
    const daytona = vi.fn();
    await expect(runSandboxPreview(input, { platinum, daytona })).rejects.toThrow(
      'invalid preview config',
    );
    expect(daytona).not.toHaveBeenCalled();
  });

  it('selects only stale or unlabeled preview sandboxes for teardown', () => {
    const sandboxes = [
      { id: 'keep', metadata: { owner: 'kortix-preview', pr_number: '10', git_sha: 'a' } },
      { id: 'stale', metadata: { owner: 'kortix-preview', pr_number: '10', git_sha: 'b' } },
      { id: 'closed', metadata: { owner: 'kortix-preview', pr_number: '11', git_sha: 'c' } },
      { id: 'ci', metadata: { owner: 'kortix-ci', pr_number: '11', git_sha: 'c' } },
    ];
    const active = new Map([[10, 'a']]);
    expect(selectStalePreviewSandboxIds(sandboxes, active)).toEqual(['stale', 'closed']);
  });
});
