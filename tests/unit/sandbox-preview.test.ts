import { describe, expect, it, vi } from 'vitest';
import {
  PreviewInfrastructureError,
  buildPreviewBootstrapScript,
  previewLockfileHash,
  previewSandboxIdentity,
  previewSandboxName,
  runSandboxPreview,
  selectStalePreviewSandboxIds,
  selectTeardownSandboxIds,
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

  it('keeps a branch environment serving through the three ways it went dark', () => {
    // pi.kortix.com, 2026-09-04: 34 GB of images and 0 bytes free took the
    // stack down; a failed deploy then left every container in Created; and
    // the next deploys died at checkout because the reused sandbox's pnpm
    // store predated a dependency the branch had added. Each has its own line
    // in the bootstrap now, and each is asserted here by the text a deploy
    // actually runs.
    const script = buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'pi-worker',
      sha: 'a'.repeat(40),
      prNumber: 6998,
      origin: 'https://pi.example.test',
      runTests: false,
    });
    // 1. The offline install is the fast path, not the only path.
    expect(script).toContain('pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile');
    // 2. Disk is reclaimed BEFORE the ~2.5 GB pull, gated on the disk being tight.
    const prune = script.indexOf('docker image prune -af');
    const pull = script.indexOf('pull --policy always');
    expect(prune).toBeGreaterThan(-1);
    expect(prune).toBeLessThan(pull);
    expect(script).toContain('if [ "${used:-0}" -ge 70 ]; then');
    // 3. A stack that cannot come up puts the last good image set back and
    //    still fails the deploy — a fallback, never a pass.
    expect(script).toContain('restore_last_good() {');
    expect(script).toContain('cp "$STATE/last-good.env"');
    expect(script).toContain('test "$stack_attempt" -lt 2 || restore_last_good');
    const restoreBody = script.slice(script.indexOf('restore_last_good() {'), script.indexOf('pull --policy always'));
    expect(restoreBody).toContain('exit 1');
    // The copy that makes the fallback possible is taken only AFTER the
    // health check proves this image set on this commit.
    const health = script.indexOf('curl -fsS --max-time 10 "$HEALTH"');
    const saved = script.indexOf('"$STATE/last-good.env"', health);
    expect(saved).toBeGreaterThan(health);
    // 4. The guard is installed as soon as docker is up, before configure or
    //    stack can fail — a dead deploy still leaves a watcher behind.
    const guard = script.indexOf('docker run -d --name kortix-preview-guard');
    // The phase markers are written with a REAL newline inside the quotes (the
    // template's \n), so the search string needs one too.
    const configure = script.indexOf("printf 'configure\n' > \"$PHASE\"");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(configure);
    expect(script).toContain("<<'KORTIX_PREVIEW_GUARD_EOF'");
    expect(script).toContain('-e KORTIX_PREVIEW_INSTANCE=pr-6998');
    // Same instance dir the deploy uses; the guard's compose resolves the same files.
    expect(script).toContain('-v /workspace/kortix-preview:/workspace/kortix-preview');
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
    // The Caddyfile is a bind mount: `compose up -d` will not recreate the edge
    // for new bytes in it, and Caddy does not watch it. Without an explicit
    // reload a reused sandbox keeps the config it booted with — which pins a
    // stale X-Forwarded-Host and kills every Server Action.
    expect(script).toContain('exec -T preview-edge caddy reload --config /etc/caddy/Caddyfile');
    expect(script).not.toContain('https://pi.example.test/v1/health');
    // The stack is still CONFIGURED with the public origin — that is what ends
    // up in SITE_URL, the redirect allowlist and the frontend's own URLs.
    expect(script).toContain("PREVIEW_ORIGIN='https://pi.example.test'");
  });

  it('retires a branch environment when its BRANCH is gone, not when its PR closes', () => {
    // The rule this test used to state was "absence from activePullRequests IS
    // the retirement signal", which made CLOSING the pull request destroy the
    // environment and its Postgres volume. Closing one is routine — superseded,
    // reopened later, split in two — and none of that means the work is over.
    // A branch environment is named after the branch and redeployed in place,
    // so the BRANCH is its identity: it lives exactly as long as the branch.
    const sandboxes = [
      // No open labelled pull request at all — and the branch still exists.
      {
        id: 'branch-pr-closed',
        name: 'kortix-env-feat-live',
        metadata: { owner: 'kortix-branch-env', pr_number: '10', git_sha: 'old' },
      },
      {
        id: 'branch-deleted',
        name: 'kortix-env-feat-gone',
        metadata: { owner: 'kortix-branch-env', pr_number: '11', git_sha: 'x' },
      },
      { id: 'pr-current', metadata: { owner: 'kortix-preview', pr_number: '12', git_sha: 'head' } },
      { id: 'pr-moved', metadata: { owner: 'kortix-preview', pr_number: '13', git_sha: 'stale' } },
    ];
    const active = new Map<number, string>([
      [12, 'head'],
      [13, 'head'],
    ]);
    const liveBranches = new Set(['kortix-env-feat-live']);
    // Only the branch that is GONE, plus the moved ephemeral preview.
    expect(selectStalePreviewSandboxIds(sandboxes, active, liveBranches).sort()).toEqual([
      'branch-deleted',
      'pr-moved',
    ]);
  });

  it('keeps a branch environment it cannot identify instead of assuming it is gone', () => {
    // The name is the only record of which branch a sandbox belongs to —
    // nothing writes the branch into metadata. A listing that stopped returning
    // names would therefore make every branch environment look deleted, and
    // sweeping on that would destroy all of them, volumes included, at once.
    // An unidentifiable sandbox costs money; this mistake is unrecoverable.
    const sandboxes = [{ id: 'nameless', metadata: { owner: 'kortix-branch-env' } }];
    expect(selectStalePreviewSandboxIds(sandboxes, new Map(), new Set())).toEqual([]);
  });

  it('tears down both sandbox shapes, and only this pull request\'s', () => {
    // A branch environment has autoDeleteDays: 0 — no provider expiry. If
    // teardown does not find it, NOTHING ever will, so it runs until someone
    // notices the bill.
    const sandboxes = [
      { id: 'pr-box', name: 'kortix-preview-pr-42', metadata: { owner: 'kortix-preview', pr_number: '42' } },
      { id: 'branch-box', name: 'kortix-env-feat-x', metadata: { owner: 'kortix-branch-env', pr_number: '42' } },
      // Another pull request's boxes, identical in every other way.
      { id: 'other-pr', name: 'kortix-preview-pr-43', metadata: { owner: 'kortix-preview', pr_number: '43' } },
      { id: 'other-branch', name: 'kortix-env-feat-y', metadata: { owner: 'kortix-branch-env', pr_number: '43' } },
      // Right name, wrong owner: something this system did not create.
      { id: 'impostor', name: 'kortix-env-feat-x', metadata: { owner: 'someone-else', pr_number: '42' } },
    ];

    expect(selectTeardownSandboxIds(sandboxes, { prNumber: 42, branchEnv: 'feat/x' })).toEqual([
      'pr-box',
      'branch-box',
    ]);

    // WITHOUT branchEnv the branch-named box is invisible — which is exactly how
    // a persistent environment leaks. The teardown job must always pass it.
    expect(selectTeardownSandboxIds(sandboxes, { prNumber: 42 })).toEqual(['pr-box']);

    // CHANGED DELIBERATELY: this returned [] while a branch environment was
    // owned by a pull request. It is owned by its BRANCH now, so a mismatched
    // number no longer hides it — two pull requests cannot share one branch,
    // and the `delete` event that retires it carries no number to agree with.
    expect(selectTeardownSandboxIds(sandboxes, { prNumber: 99, branchEnv: 'feat/x' })).toEqual([
      'branch-box',
    ]);

    // Branch alone: exactly what the branch-deleted teardown job passes.
    expect(selectTeardownSandboxIds(sandboxes, { branchEnv: 'feat/x' })).toEqual(['branch-box']);
    expect(selectTeardownSandboxIds(sandboxes, { branchEnv: 'feat/y' })).toEqual(['other-branch']);
    // The wrong-owner box shares that name and is still never returned.
    expect(selectTeardownSandboxIds(sandboxes, { branchEnv: 'feat/x' })).not.toContain('impostor');

    // Neither key is a caller bug, and it must FAIL rather than quietly delete
    // nothing: a branch environment has no expiry to catch what teardown missed.
    expect(() => selectTeardownSandboxIds(sandboxes, {})).toThrow(
      /needs a pull request number or a branch/,
    );
  });

  it('does not sweep a branch environment for the one thing that retires a preview', () => {
    // A MOVED HEAD is the difference between the two owners. It makes an
    // ephemeral preview stale — it was built for exactly one commit — but it is
    // the normal state of a branch environment, which is redeployed in place and
    // must survive it. Sweeping on sha would delete a live environment on every
    // push, which is the whole thing persistence exists to prevent.
    const sandboxes = [
      { id: 'pr-moved', metadata: { owner: 'kortix-preview', pr_number: '4242', git_sha: 'built' } },
      {
        id: 'branch-env',
        name: 'kortix-env-pi-worker',
        metadata: { owner: 'kortix-branch-env', pr_number: '6998', git_sha: 'built' },
      },
    ];
    const active = new Map<number, string>([
      [4242, 'pushed'],
      [6998, 'pushed'],
    ]);
    const liveBranches = new Set(['kortix-env-pi-worker']);
    expect(selectStalePreviewSandboxIds(sandboxes, active, liveBranches)).toEqual(['pr-moved']);
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
