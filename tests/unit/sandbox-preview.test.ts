import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  PreviewInfrastructureError,
  assertPreviewManagedGitInstallation,
  buildPreviewBootstrapScript,
  previewLockfileHash,
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

const previewPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

const previewSecrets = {
  KORTIX_GITHUB_APP_ID: '3812697',
  KORTIX_GITHUB_APP_PRIVATE_KEY: previewPrivateKey,
  KORTIX_GITHUB_APP_SLUG: 'kortix-preview-test',
  MANAGED_GIT_GITHUB_INSTALL_ID: '140097279',
  MANAGED_GIT_GITHUB_OWNER: 'managed-kortix',
};

describe('provider-neutral preview lifecycle', () => {
  it('accepts one dedicated managed Git installation with repository administration', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 3812697, slug: 'kortix-preview-test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 140097279,
              account: { login: 'managed-kortix', type: 'Organization' },
              repository_selection: 'all',
              permissions: { administration: 'write', contents: 'write', metadata: 'read' },
            },
          ]),
          { status: 200 },
        ),
      );

    await expect(
      assertPreviewManagedGitInstallation({
        secrets: previewSecrets,
        fetchImpl,
        nowMs: 1_800_000_000_000,
      }),
    ).resolves.toEqual({
      appId: 3812697,
      slug: 'kortix-preview-test',
      installationId: 140097279,
      owner: 'managed-kortix',
    });
  });

  it('rejects a shared App with more than one installation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 3812697, slug: 'kortix-preview-test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 140097279,
              account: { login: 'managed-kortix', type: 'Organization' },
              repository_selection: 'all',
              permissions: { contents: 'write', metadata: 'read' },
            },
            {
              id: 134718821,
              account: { login: 'kortix-ai', type: 'Organization' },
              permissions: { contents: 'write', metadata: 'read' },
            },
          ]),
          { status: 200 },
        ),
      );

    await expect(
      assertPreviewManagedGitInstallation({ secrets: previewSecrets, fetchImpl }),
    ).rejects.toThrow('exactly one installation; received 2');
  });

  it('rejects a dedicated installation limited to selected repositories', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 3812697, slug: 'kortix-preview-test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 140097279,
              account: { login: 'managed-kortix', type: 'Organization' },
              repository_selection: 'selected',
              permissions: { administration: 'write', contents: 'write', metadata: 'read' },
            },
          ]),
          { status: 200 },
        ),
      );

    await expect(
      assertPreviewManagedGitInstallation({ secrets: previewSecrets, fetchImpl }),
    ).rejects.toThrow('repository access must include all repositories; received selected');
  });

  it('rejects the dedicated installation without repository administration permission', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 3812697, slug: 'kortix-preview-test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 140097279,
              account: { login: 'managed-kortix', type: 'Organization' },
              repository_selection: 'all',
              permissions: { contents: 'write', metadata: 'read' },
            },
          ]),
          { status: 200 },
        ),
      );

    await expect(
      assertPreviewManagedGitInstallation({ secrets: previewSecrets, fetchImpl }),
    ).rejects.toThrow(
      'permissions must be administration:write and contents:write; received administration:missing contents:write',
    );
  });

  it('uses one stable sandbox name per pull request', () => {
    expect(previewSandboxName(6337)).toBe('kortix-preview-pr-6337');
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
      provider: 'platinum',
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
    expect(script).not.toContain('--storage-driver=fuse-overlayfs');
    expect(script).toContain('/workspace/kortix-test-results.tar.gz');
    expect(script).toContain('kortix-preview.exit');
    expect(script).not.toContain('ecs-preview');
  });

  test('uses the kernel-independent Docker storage driver in Daytona previews', () => {
    const script = buildPreviewBootstrapScript({
      provider: 'daytona',
      repository: 'kortix-ai/suna',
      ref: 'refs/pull/6353/head',
      sha: 'a'.repeat(40),
      prNumber: 6353,
      origin: 'https://preview.example.com/',
    });

    expect(script).toContain(
      'dockerd --host=unix:///var/run/docker.sock --storage-driver=fuse-overlayfs',
    );
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
