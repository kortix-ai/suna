/**
 * Provider-neutral repo seeder: lay down an initial commit on a freshly-created
 * (empty) managed repo by pushing a set of files from a throwaway temp clone.
 *
 * Used by the web "Create project" flow — there's no local working tree to push
 * (unlike `kortix ship`), so the server seeds the starter or sessions can't boot
 * from an empty repo. Works for any HTTPS git remote (GitHub, GitLab, …) via
 * the same `x-access-token` basic scheme, injected per-invocation through
 * http.extraHeader so the token never lands in a config file.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SeedFile } from './types';

const execFileAsync = promisify(execFile);

export async function seedRepoViaGitPush(input: {
  upstreamUrl: string;
  token: string;
  files: SeedFile[];
  branch?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
  /**
   * Optional DETERMINISTIC base layer, committed FIRST with pinned identity +
   * dates so every project of the same starter shares an identical root SHA.
   * `files` then lands as a second (normal) commit. That shared root lets a
   * sandbox materialize the repo as image-baked-scaffold clone + delta-fetch
   * instead of a full clone through the (slow, in dev) git path — the dominant
   * per-session cost (measured 9s through the cloudflared tunnel, 2026-06-13).
   */
  baseFiles?: SeedFile[];
}): Promise<void> {
  const branch = input.branch || 'main';
  const name = input.authorName || 'Kortix';
  const email = input.authorEmail || 'noreply@kortix.ai';
  const dir = await mkdtemp(join(tmpdir(), 'kortix-seed-'));

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[], extra: string[] = []) =>
    execFileAsync('git', [...extra, ...args], { cwd: dir, env, timeout: 60_000 });

  const writeFiles = async (files: SeedFile[]) => {
    for (const file of files) {
      const full = join(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }
  };
  // Pinned identity + dates → deterministic commit SHA across projects.
  const PINNED = {
    GIT_AUTHOR_NAME: 'Kortix', GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix', GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };

  try {
    await run(['init', '-b', branch]);
    await run(['config', 'user.name', name]);
    await run(['config', 'user.email', email]);
    if (input.baseFiles?.length) {
      await writeFiles(input.baseFiles);
      await run(['add', '-A']);
      await execFileAsync('git', ['commit', '-m', 'chore: scaffold Kortix project'],
        { cwd: dir, timeout: 60_000, env: { ...env, ...PINNED } });
    }
    await writeFiles(input.files);
    await run(['add', '-A']);
    // Commit only if the per-project files differ from the base (avoids an
    // empty second commit when baseFiles === files).
    const status = await run(['status', '--porcelain']);
    if (status.stdout.toString().trim().length > 0) {
      await run(['commit', '-m', input.baseFiles?.length ? 'chore: project setup' : (input.commitMessage || 'chore: scaffold Kortix project')]);
    } else if (!input.baseFiles?.length) {
      await run(['commit', '-m', input.commitMessage || 'chore: scaffold Kortix project']);
    }

    const host = new URL(input.upstreamUrl).host;
    const encoded = Buffer.from(`x-access-token:${input.token}`).toString('base64');
    await run(
      ['push', input.upstreamUrl, `${branch}:refs/heads/${branch}`],
      ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${encoded}`],
    );
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr?.toString() || err.message || 'git failed').trim();
    throw new Error(`git seed failed — ${detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
