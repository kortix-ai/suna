/**
 * The declared-agent roster at ONE commit, read exactly the way the release
 * builder reads it.
 *
 * `loadProjectAgents` (projects/agents.ts) reads the manifest at the project's
 * DEFAULT BRANCH. A release is built at a session's base ref, and the
 * re-point decision must be taken against the same bytes the release compiles
 * from — otherwise a session on a feature branch is re-pointed by main's
 * manifest. So this loader goes through `readManifestFromRepo` at the commit,
 * the same call `resolveSelectedAgentConfigForSession` makes, imports resolved
 * and all, and then through the same `extractAgents` the grant pipeline uses.
 *
 * Memoised per `(project, commit)`. A commit is immutable, so the only reason
 * the TTL is short is to bound memory, not freshness.
 */

import { readManifestFromRepo } from '../projects/git';
import type { GitBackedProject } from '../projects/git/types';
import { extractAgents } from '../projects/agents';
import { parseManifestString } from '../projects/triggers';
import { manifestCandidatePaths, manifestFormatForPath } from '@kortix/manifest-schema';
import { ttlMemo } from '../shared/ttl-memo';
import type { DeclaredAgentRoster } from './session-agent';

const ROSTER_TTL_MS = 60_000;

/** A project that declares nothing: every decision answers "keep what you have". */
const UNGOVERNED: DeclaredAgentRoster = { enabled: [], defaultAgent: null, readable: true, governed: false };
/** A read that failed: never a re-point. */
const UNREADABLE: DeclaredAgentRoster = { enabled: [], defaultAgent: null, readable: false, governed: false };

async function readRoster(project: GitBackedProject, commit: string): Promise<DeclaredAgentRoster> {
  let found: Awaited<ReturnType<typeof readManifestFromRepo>>;
  try {
    found = await readManifestFromRepo(
      project,
      manifestCandidatePaths(project.manifestPath).map((candidate) => candidate.path),
      commit,
      { strictRef: true },
    );
  } catch {
    return UNREADABLE;
  }
  if (!found) return UNGOVERNED;

  let parsed;
  try {
    parsed = parseManifestString(
      found.content,
      manifestFormatForPath(found.path),
      found.path,
      found.sha,
      found.candidatePaths,
      found.commit,
    );
  } catch {
    return UNREADABLE;
  }

  const loaded = extractAgents(parsed);
  // A manifest that failed to parse an agent entry proves nothing about which
  // agents exist. Same rule as `grantFromLoadedAgents`: never narrow on an error.
  if (loaded.errors.length > 0) return UNREADABLE;
  const enabled = loaded.specs.filter((spec) => spec.enabled).map((spec) => spec.name);
  if (enabled.length === 0) return UNGOVERNED;
  return {
    enabled,
    defaultAgent: loaded.defaultAgent && enabled.includes(loaded.defaultAgent) ? loaded.defaultAgent : null,
    readable: true,
    governed: true,
  };
}

const memo = ttlMemo({
  ttlMs: ROSTER_TTL_MS,
  keyFn: (project: GitBackedProject, commit: string) => `${project.projectId}\0${commit}`,
  loader: readRoster,
  // Never cache "the read failed" — the next caller must retry.
  shouldCache: (roster: DeclaredAgentRoster) => roster.readable,
  maxEntries: 2_000,
});

export function loadAgentRosterAtCommit(project: GitBackedProject, commit: string): Promise<DeclaredAgentRoster> {
  return memo(project, commit);
}

export function __clearAgentRosterCacheForTests(): void {
  memo.clear();
}
