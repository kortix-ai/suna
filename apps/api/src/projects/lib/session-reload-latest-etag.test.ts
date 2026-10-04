/**
 * `latestAgentConfigEtag` is the mirror-reading stage of the polled
 * `GET /v1/projects/:id/sessions/:id/config` route, and the freshness contract
 * behind its `stale` answer. KRTX-818: 26 of 56 requests 5xx in one hour, every
 * deadline 503 with `git;dur` 24.4–25.0s and `config_pending_stages:
 * latest_etag`.
 *
 * Proven here against a real local git remote, no network, no database:
 *
 * 1. The read must catch a push that bypassed Kortix on every call. The old
 *    mechanism dropped the mirror's freshness stamp so the compile's own read
 *    fetched; the new one proves the ref against the remote
 *    (`CompileReadOptions.forceRefresh`). A read without the option serves the
 *    60s TTL and answers the pre-push etag — the exact "already up to date"
 *    lie this route exists to prevent.
 * 2. A failed database read still throws. Only the mirror wait may degrade to
 *    `null`; swallowing a db error would turn every outage into a silent
 *    "could not tell".
 */

import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MANIFEST_V1 = `kortix_version: 2
default_agent: helper
agents:
  helper:
    kortix_permissions: []
`;
const MANIFEST_V2 = `kortix_version: 2
default_agent: reviewer
agents:
  reviewer:
    kortix_permissions: []
`;

const originRoot = await mkdtemp(join(tmpdir(), 'krtx818-origin-'));
const cacheRoot = await mkdtemp(join(tmpdir(), 'krtx818-cache-'));
// The mirror cache must not touch the developer's or CI's real cache.
process.env.KORTIX_GIT_CACHE_DIR = cacheRoot;

const git = (...args: string[]) => execFileAsync('git', args, { cwd: originRoot });
await git('init', '-b', 'main', '.');
await git('config', 'user.email', 'krtx818-test@example.com');
await git('config', 'user.name', 'krtx818 test');
await writeFile(join(originRoot, 'kortix.yaml'), MANIFEST_V1);
await git('add', '.');
await git('commit', '-m', 'manifest v1');

const { latestAgentConfigEtag, LATEST_ETAG_BUDGET_MS } = await import('./session-reload');
const { resolveCompiledAgentConfigForSession } = await import('./compile-agent-config');

const project = {
  projectId: 'krtx818-freshness-probe',
  repoUrl: originRoot,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};

const CALL = {
  projectId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  baseRef: 'main',
} as const;

describe('the config etag read stays fresh without a whole-mirror fetch', () => {
  test('a push that bypassed Kortix is caught on the next forced read', async () => {
    const before = await resolveCompiledAgentConfigForSession(project, 'main', {
      forceRefresh: true,
    });
    expect(before).toBeTruthy();

    // The merge lands straight on the remote: no Kortix write, so no
    // `invalidateProjectMirror` broadcast reaches this process.
    await writeFile(join(originRoot, 'kortix.yaml'), MANIFEST_V2);
    await git('add', '.');
    await git('commit', '-m', 'manifest v2');

    // A read without the proof serves the 60s TTL: the pre-push manifest.
    const ttlRead = await resolveCompiledAgentConfigForSession(project, 'main');
    expect(ttlRead).toBe(before);

    // The forced read proves the ref against the remote, sees the moved tip,
    // fetches, and compiles the new manifest.
    const after = await resolveCompiledAgentConfigForSession(project, 'main', {
      forceRefresh: true,
    });
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  test('the etag function runs the same forced read and bounds its wait', async () => {
    // Source contract for the two seams the behavioral test above cannot see
    // from here: the etag resolution must force the ref-scoped refresh and
    // bound the wait (the 30s-per-op, 3-attempt mirror fetch must not outrun
    // the 25s request deadline), and it must not drop the mirror stamp — that
    // made every later unforced read of the same request pay its own fetch.
    const src = await Bun.file(new URL('./session-reload.ts', import.meta.url).pathname).text();
    const body = src.split('export async function latestAgentConfigEtag(')[1]?.split('\n}\n')[0];
    expect(body).toBeTruthy();
    expect(body).toContain('forceRefresh: true');
    expect(body).toContain('withTimeout(');
    expect(body).not.toContain('invalidateProjectMirror(input.projectId)');
    expect(LATEST_ETAG_BUDGET_MS).toBeLessThan(25_000);
    expect(LATEST_ETAG_BUDGET_MS).toBeGreaterThan(0);
  });

  test('both compile entry points thread the forced refresh', async () => {
    const src = await Bun.file(
      new URL('./compile-agent-config.ts', import.meta.url).pathname,
    ).text();
    for (const name of ['resolveCompiledAgentConfigForSession', 'resolveSelectedAgentConfigForSession']) {
      const body = src.split(`export async function ${name}(`)[1]?.split('\n}\n')[0];
      expect(body).toBeTruthy();
      expect(body).toContain('forceRefresh: options.forceRefresh');
    }
  });

  test('a failed database read still throws — only the mirror wait degrades', async () => {
    // The unit-suite DATABASE_URL points at a refused port (scripts/test.env):
    // the selects reject immediately. The etag read must propagate that error,
    // not answer a silent "could not tell".
    let error: unknown = null;
    try {
      await latestAgentConfigEtag(CALL);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
  });
});
