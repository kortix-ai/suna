/**
 * Create ONE managed repo and push the assembled Suna bundle to it:
 *   <bundle>/legacy/<slug>/…   (his content)         + one synthesized root
 *   kortix.toml / Dockerfile / .kortix/opencode       config (buildStarterFiles).
 *
 * The opencode.db is NOT a repo file — it's chat storage, shipped into the
 * sandbox separately (rehydrate). We move it out of the tree before pushing.
 */
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { getDefaultManagedBackend } from '../git-backends/registry';
import type { GitConnectionRef } from '../git-backends/types';
import { buildStarterFiles } from '../starter';

const STARTER_TEMPLATE = 'general-knowledge-worker';

function git(args: string[], cwd: string, secret = false): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    const err = new TextDecoder().decode(r.stderr);
    throw new Error(`git ${secret ? args[0] : args.join(' ')} failed: ${err.slice(0, 400)}`);
  }
}

export interface PushedRepo {
  projectId: string;
  provider: string;
  upstreamUrl: string;
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string;
  externalRepoId: string | null;
  installationId: string | null;
  credentialRef: string | null;
}

export async function pushBundleAsRepo(accountId: string, bundleDir: string): Promise<PushedRepo> {
  const backend = getDefaultManagedBackend();
  if (!(await backend.isConfigured())) throw new Error(`managed git backend "${backend.id}" not configured (GitHub App creds)`);
  if (!backend.authedPushUrl) throw new Error(`backend "${backend.id}" cannot mint a push URL`);

  const projectId = crypto.randomUUID();
  const slug = `suna-legacy-${projectId.slice(0, 8)}`;
  const repo = await backend.createRepo({ accountId, projectId, slug, defaultBranch: 'main', isPrivate: true });

  const ref: GitConnectionRef = {
    provider: repo.provider, upstreamUrl: repo.upstreamUrl, externalRepoId: repo.externalRepoId,
    repoOwner: repo.repoOwner, repoName: repo.repoName, installationId: repo.installationId,
    credentialRef: repo.credentialRef, defaultBranch: repo.defaultBranch, managed: true, metadata: {},
  };
  const pushUrl = await backend.authedPushUrl(ref);

  // Keep opencode.db + manifest OUT of the repo (chat storage, not source).
  for (const f of ['opencode.db', 'migration-manifest.json']) {
    const p = join(bundleDir, f);
    if (existsSync(p)) renameSync(p, join(dirname(bundleDir), `${projectId}.${f}`));
  }

  // One synthesized root config for the whole project.
  const repoFullName = repo.repoOwner && repo.repoName ? `${repo.repoOwner}/${repo.repoName}` : undefined;
  for (const f of buildStarterFiles({ projectName: 'Legacy (Suna) projects', repoFullName, template: STARTER_TEMPLATE })) {
    const full = join(bundleDir, f.path);
    if (existsSync(full)) continue; // never clobber his content
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }

  rmSync(join(bundleDir, '.git'), { recursive: true, force: true });
  git(['init', '-b', repo.defaultBranch], bundleDir);
  git(['config', 'user.email', 'migration@kortix.com'], bundleDir);
  git(['config', 'user.name', 'Kortix Migration'], bundleDir);
  git(['add', '-A'], bundleDir);
  git(['commit', '-m', 'Import Suna legacy projects (chats restored as sessions; files under legacy/)'], bundleDir);
  git(['push', pushUrl, `HEAD:${repo.defaultBranch}`], bundleDir, true);

  return {
    projectId, provider: repo.provider, upstreamUrl: repo.upstreamUrl,
    repoOwner: repo.repoOwner, repoName: repo.repoName, defaultBranch: repo.defaultBranch,
    externalRepoId: repo.externalRepoId, installationId: repo.installationId, credentialRef: repo.credentialRef,
  };
}
