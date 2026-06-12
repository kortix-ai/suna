/**
 * Provider-neutral repo duplicator: copy the contents of one repo's default
 * branch into a freshly-created (empty) managed repo.
 *
 * Used by the project "Duplicate" flow. Unlike `seedRepoViaGitPush` (which lays
 * down a fixed starter), this clones the *source* project's repo and pushes a
 * single fresh commit (history is intentionally flattened — a duplicate is a new
 * project, not a fork) to the destination. Both ends authenticate with the same
 * `x-access-token` basic scheme, injected per-invocation through
 * http.extraHeader so neither token ever lands in a git config file.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function extraHeaderArgs(upstreamUrl: string, token: string | null): string[] {
  if (!token) return [];
  const host = new URL(upstreamUrl).host;
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${encoded}`];
}

/**
 * Clone the source repo's branch and push its tree as a single fresh commit to
 * the destination repo's branch. The destination must already exist (empty).
 */
export async function cloneRepoContents(input: {
  sourceUrl: string;
  sourceToken: string | null;
  sourceBranch: string;
  destUrl: string;
  destToken: string | null;
  destBranch?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
}): Promise<void> {
  const destBranch = input.destBranch || input.sourceBranch || 'main';
  const name = input.authorName || 'Kortix';
  const email = input.authorEmail || 'noreply@kortix.ai';
  const dir = await mkdtemp(join(tmpdir(), 'kortix-clone-'));

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[], extra: string[] = []) =>
    execFileAsync('git', [...extra, ...args], { cwd: dir, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

  try {
    // Shallow single-branch clone of the source — we only need the current tree,
    // not its history (a duplicate starts fresh).
    await run(
      [
        'clone',
        '--depth', '1',
        '--single-branch',
        '--branch', input.sourceBranch,
        input.sourceUrl,
        '.',
      ],
      extraHeaderArgs(input.sourceUrl, input.sourceToken),
    );

    // Drop the source's git history: re-init so the duplicate has exactly one
    // clean commit and no link back to the original repo.
    await rm(join(dir, '.git'), { recursive: true, force: true });
    await run(['init', '-b', destBranch]);
    await run(['config', 'user.name', name]);
    await run(['config', 'user.email', email]);
    await run(['add', '-A']);
    await run(['commit', '-m', input.commitMessage || 'chore: duplicate Kortix project']);
    await run(
      ['push', input.destUrl, `${destBranch}:refs/heads/${destBranch}`],
      extraHeaderArgs(input.destUrl, input.destToken),
    );
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr?.toString() || err.message || 'git failed').trim();
    throw new Error(`git duplicate failed — ${detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
