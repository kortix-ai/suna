import { isAbsolute } from 'node:path';
import { commitFileToBranch, invalidateProjectMirror } from '../git';
import { commitMultipleFilesToBranch } from '../git/branches';
import { isRemotePushPolicyRejection } from '../git/mirror';
import { commitFile, getFileSha, type GitHubAuthContext } from '../github';
import { MANIFEST_FILENAME, type GitTriggerSpec, type ParsedManifest, manifestWrites, readManifest, synthesizeBlankManifest, triggerSpecToTomlEntry } from '../triggers';
import { parseGitHubRepoUrl, resolveProjectGitAuth, withProjectGitAuth } from './git';
import type { ProjectRow } from './serializers';

/**
 * Read the project's manifest. If the manifest doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 *
 * MUST be kortix_version 2, not KNOWN_SCHEMA_VERSION (which deliberately
 * stays pinned at 1 — see its own doc comment in ../triggers.ts). Every
 * project created through POST /projects/provision (seeded or not) is
 * stamped `metadata.require_declared_agents: true` and reads/writes
 * through the v2-only agent-config API (`applyAgentBlockV2`/
 * `applyDefaultAgentV2` in ./agent-config-v2.ts hard-refuse a v1
 * manifest). A blank project (no `seed_starter`, so no kortix.yaml ever
 * got pushed) synthesizing v1 here meant every agent-config write 400'd
 * with "upgrade to kortix_version 2" before it could ever commit a real
 * manifest — a self-inflicted catch-22 that left the project permanently
 * un-declarable (AGENT_NOT_DECLARED on every session-create) short of a
 * force-pushed kortix.yaml or a full re-provision with `seed_starter:true`.
 *
 * Delegates the actual synthesis to `synthesizeBlankManifest` (../triggers.ts)
 * — the SAME shape `loadProjectAgents` (../agents.ts) synthesizes on the
 * session-create read path, so a blank project's declared-agent check passes
 * with zero writes needed on EITHER path, not just this edit one (see that
 * function's doc comment for why the two must stay in sync).
 */
type ManifestProject = ProjectRow & {
  gitAuthToken?: string | null;
  gitAuthHeaders?: Record<string, string>;
};

function hasResolvedGitAuth(project: ManifestProject): project is ProjectRow & {
  gitAuthToken: string | null;
  gitAuthHeaders?: Record<string, string>;
} {
  return 'gitAuthToken' in project || 'gitAuthHeaders' in project;
}

/**
 * The manifest a Customize editor shows or rewrites. Always read after a forced
 * mirror refresh: each API replica refreshes its own git mirror at most every
 * 60 s, and a write refreshes only the replica that handled it, so an
 * unforced read on another replica serves the manifest from before the save.
 * Editor reads are not a hot path; one `git fetch` per read is the price of
 * showing what was committed.
 */
export async function loadManifestForEdit(project: ManifestProject): Promise<ParsedManifest> {
  const gitProject = hasResolvedGitAuth(project) ? project : await withProjectGitAuth(project);
  const existing = await readManifest(gitProject, { forceRefresh: true });
  if (existing) return existing;
  return synthesizeBlankManifest({ name: project.name, manifestPath: project.manifestPath });
}

/** Insert or replace a trigger by slug inside the manifest's triggers array. */

export function upsertTriggerInManifest(
  manifest: ParsedManifest,
  spec: GitTriggerSpec,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const idx = current.findIndex(
    (entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug,
  );
  const entry = triggerSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/** Remove a trigger by slug from the manifest's triggers array. */

export function removeTriggerFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const next = current.filter((entry) => !(typeof entry?.slug === 'string' && entry.slug === slug));
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/**
 * Commit a single file to the project's default branch — the generic engine
 * behind `commitManifest` (kortix.yaml/toml) and the agent-config route's
 * `.md` behavior-file writes. One file, one commit per call.
 */
export async function commitRepoFile(
  project: ManifestProject,
  path: string,
  content: string,
  message: string,
  expectedFileRevision?: string | null,
  expectedCandidatePaths?: readonly string[],
  /** Same-commit companions of `path`: more files to write, and more blobs
   *  that must be unchanged. Only a manifest with `imports:` passes these. */
  extra?: {
    files?: Array<{ path: string; content: string }>;
    alsoExpect?: Array<{ path: string; sha: string }>;
    /** The file `expectedFileRevision` guards, when it is not `path`: an edit
     *  to an imported entry writes only that file, yet the root manifest's
     *  revision is still the one the read was anchored on. */
    expectedPath?: string;
  },
): Promise<{ ok: true } | { error: string; status: number }> {
  const repo = parseGitHubRepoUrl(project.repoUrl);
  if (repo && expectedFileRevision === undefined && !extra) {
    return commitGitHubRepoFile(project, repo, path, content, message);
  }
  return commitGitCliRepoFile(project, path, content, message, expectedFileRevision, expectedCandidatePaths, extra);
}

async function commitGitHubRepoFile(
  project: ManifestProject,
  repo: NonNullable<ReturnType<typeof parseGitHubRepoUrl>>,
  path: string,
  content: string,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const branch = project.defaultBranch;
    let auth: GitHubAuthContext | undefined;
    if (hasResolvedGitAuth(project)) {
      auth = project.gitAuthToken
        ? { token: project.gitAuthToken, source: 'project_credential' }
        : undefined;
    } else {
      try {
        auth = (await resolveProjectGitAuth(project)).auth ?? undefined;
      } catch (err) {
        return {
          error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`,
          status: 502,
        };
      }
    }
    try {
      const existingSha = await getFileSha({
        owner: repo.owner,
        repo: repo.repo,
        path,
        branch,
        auth,
      });
      await commitFile({
        owner: repo.owner,
        repo: repo.repo,
        path,
        content,
        message,
        branch,
        existingSha: existingSha ?? undefined,
        auth,
      });
    } catch (err) {
      return {
        error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
    invalidateProjectMirror(project.projectId);
    // The base branch moved through the Contents API. The git-CLI path below
    // notifies from `commitMultipleFilesToBranch`.
    void import('./config-convergence-triggers')
      .then((triggers) => triggers.notifyBaseBranchMoved(project.projectId, branch, 'manifest-write'))
      .catch(() => {});
    return { ok: true };
}

async function commitGitCliRepoFile(
  project: ManifestProject,
  path: string,
  content: string,
  message: string,
  expectedFileRevision?: string | null,
  expectedCandidatePaths?: readonly string[],
  extra?: Parameters<typeof commitRepoFile>[6],
): Promise<{ ok: true } | { error: string; status: number }> {
  const branch = project.defaultBranch;
  // Any other host (GitLab, generic HTTPS remote): commit via the git CLI.
  // The old code bailed here with "Project repo URL is
  // not a GitHub URL", which broke every connector and trigger manifest edit
  // on managed/self-hosted projects. Mirrors createRemoteSessionBranch's
  // GitHub-fast-path / git-CLI-fallback split.
  let gitProject: ProjectRow & {
    gitAuthToken: string | null;
    gitAuthHeaders?: Record<string, string>;
  };
  if (hasResolvedGitAuth(project)) {
    gitProject = {
      ...project,
      gitAuthToken: project.gitAuthToken ?? null,
    };
  } else {
    try {
      gitProject = await withProjectGitAuth(project);
    } catch (err) {
      return {
        error: `Git auth unavailable: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
  }
  const localRepository = process.env.KORTIX_LOCAL_DEV === '1' && isAbsolute(gitProject.repoUrl);
  if (!gitProject.gitAuthToken && !localRepository) {
    return { error: 'No git credentials available to write to the project repo', status: 502 };
  }

  try {
    const commit = { message, branch, authorName: 'Kortix', authorEmail: 'noreply@kortix.ai' };
    if (extra) {
      // A manifest with `imports:` — every changed source file in ONE commit,
      // guarded by the root revision plus every imported file's revision.
      await commitMultipleFilesToBranch(gitProject, {
        ...commit,
        files: [{ path, content }, ...(extra.files ?? [])],
        alsoExpect: extra.alsoExpect,
        expectedFileRevision:
          expectedFileRevision === undefined
            ? undefined
            : {
                path: extra.expectedPath ?? path,
                sha: expectedFileRevision,
                candidatePaths: expectedCandidatePaths,
              },
      });
    } else {
      await commitFileToBranch(gitProject, {
        ...commit,
        path,
        content,
        expectedFileRevision:
          expectedFileRevision === undefined
            ? undefined
            : { path, sha: expectedFileRevision, candidatePaths: expectedCandidatePaths },
      });
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'GitFileRevisionConflictError') {
      return { error: err.message, status: 409 };
    }
    if (isRemotePushPolicyRejection(err)) {
      return {
        error: 'The repository rejected the push because of branch protection or repository rules. Allow the Kortix GitHub App to push to the default branch, or connect a repository where it can, then try again.',
        status: 409,
      };
    }
    return {
      error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
      status: 502,
    };
  }

  invalidateProjectMirror(project.projectId);
  return { ok: true };
}

/**
 * Commit a new revision of the project manifest (kortix.yaml, or kortix.toml
 * for a legacy v1 project) to the project's default branch. All trigger CRUD
 * funnels through this — one file, one commit per edit.
 */

export async function commitManifest(
  project: ManifestProject,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  // Write back to the SAME file we read (kortix.yaml or kortix.toml, or a custom
  // path) in its own format — never a hardcoded name, or a yaml project's edits
  // would silently land in a second kortix.toml the runtime doesn't read.
  // A manifest with `imports:` writes the file that declares the edited entry
  // (see `manifestWrites`), all in this one commit.
  const manifestFile = manifest.path || project.manifestPath || MANIFEST_FILENAME;
  const writes = manifestWrites(manifest, manifestFile);
  const [first, ...rest] = writes.files;
  if (!first) return { ok: true };
  return commitRepoFile(
    project,
    first.path,
    first.content,
    message,
    manifest.revision,
    manifest.candidatePaths,
    manifest.imports
      ? { files: rest, alsoExpect: writes.alsoExpect, expectedPath: manifestFile }
      : undefined,
  );
}
