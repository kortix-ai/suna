import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildStarterFiles, DEFAULT_STARTER_TEMPLATE_ID } from '../starter';

const execFileAsync = promisify(execFile);

/**
 * Identity of the canonical starter scaffold — the SAME deterministic commit
 * `stageScaffoldRepo` (snapshots/build-context.ts) bakes into every sandbox
 * image at /opt/kortix/scaffold.git and `seed.ts` commits first into every
 * managed repo: pinned author, pinned dates, starter files only.
 *
 * The fast-boot delta bundle is `tip ^root`; the sandbox can only apply it
 * when its baked scaffold holds the root's TREE. Knowing that tree here lets
 * the API skip bundling for repos that never descended from the starter
 * (imports), whose "delta" would be their whole history.
 */
export interface ScaffoldIdentity {
  rootSha: string;
  treeSha: string;
}

let identityPromise: Promise<ScaffoldIdentity> | null = null;

const PINNED_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
} as const;

async function computeScaffoldIdentity(): Promise<ScaffoldIdentity> {
  const work = await mkdtemp(join(tmpdir(), 'kortix-scaffold-identity-'));
  try {
    const files = buildStarterFiles({
      projectName: 'kortix-project',
      repoFullName: 'kortix/kortix-project',
      template: DEFAULT_STARTER_TEMPLATE_ID,
    });
    for (const f of files) {
      const full = join(work, f.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, f.content, 'utf8');
    }
    const env = { ...process.env, ...PINNED_GIT_ENV };
    const g = async (args: string[]) =>
      (await execFileAsync('git', args, { cwd: work, env, timeout: 60_000 })).stdout.trim();
    await g(['init', '-q', '-b', 'main']);
    await g(['config', 'user.name', 'Kortix']);
    await g(['config', 'user.email', 'noreply@kortix.ai']);
    await g(['add', '-A']);
    await g(['commit', '-q', '-m', 'chore: scaffold Kortix project']);
    const rootSha = await g(['rev-parse', 'HEAD']);
    const treeSha = await g(['rev-parse', 'HEAD^{tree}']);
    return { rootSha, treeSha };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Memoized per process: the starter files are static for the API's lifetime. */
export function scaffoldIdentity(): Promise<ScaffoldIdentity> {
  identityPromise ??= computeScaffoldIdentity().catch((error) => {
    identityPromise = null;
    throw error;
  });
  return identityPromise;
}

/** Tree SHA of the current starter scaffold, or null when it cannot be built here. */
export async function scaffoldTreeSha(): Promise<string | null> {
  try {
    return (await scaffoldIdentity()).treeSha;
  } catch {
    return null;
  }
}

export function resetScaffoldIdentityForTests(): void {
  identityPromise = null;
}
