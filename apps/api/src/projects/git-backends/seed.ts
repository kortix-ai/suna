/**
 * Provider-neutral repo seeder: lay down an initial commit on a freshly-created
 * (empty) managed repo by pushing a set of files from a throwaway temp clone.
 *
 * Used by the web "Create project" flow — there's no local working tree to push
 * (unlike `kortix ship`), so the server seeds the starter or sessions can't boot
 * from an empty repo. Works for any HTTPS git remote (GitHub, Freestyle, …) via
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
}): Promise<void> {
  const branch = input.branch || 'main';
  const name = input.authorName || 'Kortix';
  const email = input.authorEmail || 'noreply@kortix.ai';
  const dir = await mkdtemp(join(tmpdir(), 'kortix-seed-'));

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[], extra: string[] = []) =>
    execFileAsync('git', [...extra, ...args], { cwd: dir, env, timeout: 60_000 });

  try {
    await run(['init', '-b', branch]);
    await run(['config', 'user.name', name]);
    await run(['config', 'user.email', email]);
    for (const file of input.files) {
      const full = join(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }
    await run(['add', '-A']);
    await run(['commit', '-m', input.commitMessage || 'chore: scaffold Kortix project']);

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
