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

  it('reclaims disk both before the pull and after the stack is proven', () => {
    // A branch environment is reused forever, so nothing else ever reclaims the
    // images each deploy supersedes: ~3 GB per deploy on a 50 GB disk filled it
    // to 100% and the stack stopped coming up.
    //
    // TWO prunes, deliberately, because one is not enough:
    //  - AFTER the health assertion is the steady-state pass. The running
    //    containers pin exactly the images worth keeping, so it is the safest
    //    place to reclaim. It was also the ONLY pass, and that was the bug: it
    //    is gated on a health check, and a full disk is precisely the state
    //    that prevents the stack becoming healthy. The cleanup sat behind the
    //    failure it existed to prevent.
    //  - BEFORE the ~3 GB pull, gated on the disk actually being tight, is the
    //    one that can rescue a box already full.
    // Neither may ever fail a deploy that is otherwise healthy.
    const script = buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'pi-worker',
      sha: 'a'.repeat(40),
      prNumber: 6998,
      origin: 'https://x.example.test',
      runTests: false,
    });
    const health = script.lastIndexOf('$HEALTH');
    expect(script.indexOf('docker image prune')).toBeLessThan(health);
    expect(script.lastIndexOf('docker image prune')).toBeGreaterThan(health);

    // The early pass runs only when the disk is tight — an unconditional prune
    // before every pull would throw away the layer cache the pull relies on.
    const prePull = script.slice(0, health);
    expect(prePull).toMatch(/if \[ "\$\{used:-0\}" -ge 80 \]/);
    // An unreadable df must read as 0 and prune nothing, never as "prune".
    expect(prePull).toContain('${used:-0}');

    // No age filter: `until=24h` reclaimed 0 B on the real box, because a
    // branch environment redeploys several times a day and every superseded
    // image is younger than a day. Unfiltered it freed 20.35 GB.
    const pruneLines = script
      .split('\n')
      .filter((l) => l.trimStart().startsWith('docker ') && l.includes('prune'));
    expect(pruneLines).toHaveLength(5);
    for (const line of pruneLines) {
      // Never fatal — a healthy deploy must not fail because a prune did.
      expect(line).toContain('|| true');
      expect(line).not.toContain('until=');
    }
    expect(pruneLines.some((l) => l.includes('docker image prune -af'))).toBe(true);
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

describe('unhealthy-container recovery', () => {
  /**
   * pi-worker environment, 2026-08-29: supabase-kong sat `Up 27 hours
   * (unhealthy)` while still routing traffic, so nothing looked wrong from
   * outside. `compose up -d` only recreates for a new image, env or port, so
   * the unhealthy container was never touched; every dependent then failed
   * `depends_on: service_healthy`, and FOUR consecutive deploys across two
   * different commits died without the origin ever coming back.
   */
  const script = () =>
    buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'pi-worker',
      sha: 'a'.repeat(40),
      prNumber: 6998,
      origin: 'https://x.example.test',
      runTests: false,
    });

  it('restarts running-but-unhealthy containers BEFORE waiting on them', () => {
    const s = script();
    expect(s).toContain('docker ps --filter health=unhealthy');
    expect(s).toContain('docker restart');
    // Before the wait, not after: the retry loop reruns the same comparison
    // and reaches the same no-op, so recovering on failure would never fire.
    expect(s.indexOf('health=unhealthy')).toBeLessThan(s.indexOf('up -d --wait'));
  });

  it('scopes the restart to this instance, never a co-tenant container', () => {
    expect(script()).toContain('grep "^kortix-');
  });

  it('is a restart, never a recreate — volumes and data must survive', () => {
    const s = script();
    expect(s).not.toContain('docker rm ');
    expect(s).not.toContain('--force-recreate');
  });
});

/**
 * GitHub answers a preview sandbox's ref advertisement anonymously and then
 * REFUSES the fetch that follows.
 *
 * Measured on pi.kortix.com's sandbox (Scaleway, 51.158.248.121) on 2026-09-02:
 *   GET  /kortix-ai/suna.git/info/refs?service=git-upload-pack -> HTTP/2 200
 *   POST /kortix-ai/suna.git/git-upload-pack                   -> HTTP/2 401
 *                                       www-authenticate: Basic realm="GitHub"
 * `git ls-remote` failed 10 times out of 10 while a plain curl of the GET
 * returned 200 ten times out of ten. The repository is public; GitHub is
 * throttling unauthenticated fetches from that datacenter range, and it does it
 * on the expensive request only. So the bootstrap's `git fetch` died with
 * "could not read Username for 'https://github.com'", the checkout phase exited
 * 128, and pi.kortix.com sat on an old commit while every deploy went red.
 *
 * The runner already holds a usable token (`GH_TOKEN: ${{ github.token }}`); it
 * was simply never handed to the sandbox. It must reach git WITHOUT being
 * written into `.git/config` or a remote URL — the bootstrap script itself is
 * mode 0755 in the sandbox, so anything embedded in it is world-readable.
 */
describe('preview checkout survives GitHub refusing anonymous fetches', () => {
  const bootstrap = (extra: Record<string, unknown> = {}) =>
    buildPreviewBootstrapScript({
      repository: 'kortix-ai/suna',
      ref: 'refs/pull/6998/head',
      sha: 'b'.repeat(40),
      prNumber: 6998,
      origin: 'https://pi.kortix.com',
      runTests: false,
      ...extra,
    });

  it('authenticates the fetch through a credential helper, not a URL', () => {
    const script = bootstrap();
    const checkout = script.slice(script.indexOf('git -C "$ROOT" remote set-url'));
    const fetchAt = checkout.indexOf('git -C "$ROOT" fetch');
    const helperAt = checkout.indexOf('credential.helper');
    expect(helperAt).toBeGreaterThan(-1);
    // The helper must be configured BEFORE the fetch, or it cannot help.
    expect(helperAt).toBeLessThan(fetchAt);
  });

  it('never puts the token in the remote URL', () => {
    // A token in the URL lands in .git/config and in every error message git
    // prints. The remote must stay a bare https URL.
    const script = bootstrap();
    expect(script).toContain("remote set-url origin 'https://github.com/kortix-ai/suna.git'");
    expect(script).not.toMatch(/https:\/\/[^'"\s]*@github\.com/);
  });

  it('does not leak the token into .git/config when the snippet actually runs', async () => {
    // The first version of this inlined the helper as
    //   git config credential.helper "!f() { ...; echo "password=$(cat $F)"; }; f"
    // The nested double quotes collapse, the OUTER shell expands $(cat ...) at
    // config time, and git stores the literal token in .git/config. Text
    // assertions could not see that — only running it could. Verified: it wrote
    // `helper = "!f() { ...; echo password=<THE TOKEN>; }; f"`.
    const { mkdtemp, writeFile, mkdir, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');

    const dir = await mkdtemp(join(tmpdir(), 'kortix-cred-'));
    const state = join(dir, 'state');
    const root = join(dir, 'repo');
    await mkdir(state, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(state, '.checkout-token'), 'SENTINEL_TOKEN_DO_NOT_LEAK');
    spawnSync('git', ['-C', root, 'init', '-q']);

    const script = bootstrap();
    const start = script.indexOf('if [ -s "$STATE/.checkout-token" ]');
    const end = script.indexOf('git -C "$ROOT" fetch', start);
    const snippet = script.slice(start, end);
    // The helper hardcodes the sandbox's absolute state path; point it at ours.
    const runnable = snippet.replaceAll('/workspace/kortix-preview', state);
    const run = spawnSync('bash', ['-c', runnable], { env: { ...process.env, STATE: state, ROOT: root } });
    expect(run.status).toBe(0);

    const config = await readFile(join(root, '.git', 'config'), 'utf8');
    expect(config).not.toContain('SENTINEL_TOKEN_DO_NOT_LEAK');

    // And the helper must actually answer git's "get" with the token.
    const helper = spawnSync(join(state, '.checkout-credential-helper'), ['get'], { encoding: 'utf8' });
    expect(helper.stdout).toContain('username=x-access-token');
    expect(helper.stdout).toContain('password=SENTINEL_TOKEN_DO_NOT_LEAK');
  });

  it('never embeds the token in the script, which is mode 0755 in the sandbox', () => {
    // The helper reads it from a 0600 file at call time instead.
    const script = bootstrap();
    expect(script).toContain('.checkout-token');
    expect(script).not.toContain('ghp_');
    expect(script).not.toContain('ghs_');
  });

  it('falls back to anonymous when no token file is present', () => {
    // Not every environment hits the throttle, and a preview must not start
    // REQUIRING a credential it never needed before.
    const script = bootstrap();
    const checkout = script.slice(script.indexOf('git -C "$ROOT" remote set-url'));
    expect(checkout).toMatch(/if \[ -s .*\.checkout-token/);
  });
});
