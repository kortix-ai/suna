// The push gate's manifest check: does a push to the default branch land a
// kortix.yaml that is not YAML? Such a file turns the project to its last good
// version (`readManifest`), so the git proxy refuses it before it lands.
//
// The pack is indexed into a temporary bare repository whose
// `objects/info/alternates` names the project's mirror, then the new file is
// read from it. The pushed objects never enter the mirror. Every case the check cannot decide answers "no error": a push is never
// refused because the check failed.

import { isManifestSyntaxError, manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../lib/logger';
import { ensureCommitTrees, ensureStoreObjects, refreshMirror } from './mirror';
import { missingObjectIdsFromGitError } from './object-store';
import { refDeltaBases } from './pack-ref-deltas';
import type { GitBackedProject } from './types';

/** A push larger than this is not checked: it is forwarded as it is. */
export const MAX_CHECKED_PUSH_BYTES = 32 * 1024 * 1024;
/** The whole check, indexing included. Past it the push is forwarded unchecked. */
const CHECK_TIMEOUT_MS = 15_000;
/** Rounds of fetching the bases a thin pack needs. */
const MAX_BASE_FETCH_ROUNDS = 3;

export interface PushedManifestError {
  path: string;
  message: string;
  line?: number;
  column?: number;
}

const ZERO_SHA = /^0+$/;

function runGitWithInput(
  args: string[],
  cwd: string,
  input: Uint8Array | null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    // The quarantine has no promisor remote: a missing object fails by name, never fetches.
    const child = spawn('git', args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => resolve({ stdout: '', stderr: error.message, exitCode: 1 }));
    child.on('close', (code) =>
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code ?? 1 }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/**
 * Run a read in the quarantine. An object the mirror's partial store does not
 * hold yet is fetched into the mirror (a real upstream object), then the read
 * runs again.
 */
async function quarantineGit(
  quarantine: { path: string; mirror: string },
  args: string[],
  input: Uint8Array | null = null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  for (let round = 0; ; round += 1) {
    const result = await runGitWithInput(args, quarantine.path, input);
    if (result.exitCode === 0 || round >= MAX_BASE_FETCH_ROUNDS) return result;
    const missing = missingObjectIdsFromGitError(result.stderr);
    if (missing.length === 0) return result;
    await ensureStoreObjects(quarantine.mirror, missing);
  }
}

/** The blob id of the first manifest candidate in `commit`'s tree, or null. */
async function manifestBlob(
  quarantine: { path: string; mirror: string },
  commit: string,
  candidates: string[],
): Promise<{ path: string; blob: string } | null | 'unknown'> {
  const listed = await quarantineGit(quarantine, ['ls-tree', commit, '--', ...candidates]);
  if (listed.exitCode !== 0) return 'unknown';
  const blobs = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (match) blobs.set(match[2]!, match[1]!);
  }
  const path = candidates.find((candidate) => blobs.has(candidate));
  return path ? { path, blob: blobs.get(path)! } : null;
}

async function check(
  project: GitBackedProject,
  update: { oldSha: string; newSha: string },
  pack: Uint8Array,
): Promise<PushedManifestError | null> {
  const candidates = manifestCandidatePaths(project.manifestPath);
  const repoPath = await refreshMirror(project);
  const path = await mkdtemp(join(tmpdir(), 'kortix-push-check-'));
  const quarantine = { path, mirror: repoPath };
  try {
    const init = await runGitWithInput(['init', '--bare', '--quiet', path], tmpdir(), null);
    if (init.exitCode !== 0) return null;
    await writeFile(join(path, 'objects', 'info', 'alternates'), `${join(repoPath, 'objects')}\n`);
    // A thin pack's deltas name bases the client knew the server has: the old tip's trees and files.
    if (!ZERO_SHA.test(update.oldSha)) await ensureCommitTrees(repoPath, [update.oldSha]).catch(() => {});
    // The rest of a thin pack's bases: fetched into the mirror by id, so the pack indexes.
    const bases = refDeltaBases(pack);
    if (bases && bases.length > 0) await ensureStoreObjects(repoPath, bases).catch(() => {});
    const indexed = await quarantineGit(quarantine, ['index-pack', '--stdin', '--fix-thin'], pack);
    if (indexed.exitCode !== 0) {
      logger.warn('[git-proxy] push manifest check skipped: the pack did not index', {
        projectId: project.projectId,
        stderr: indexed.stderr.slice(0, 300),
      });
      return null;
    }
    const pushed = await manifestBlob(quarantine, update.newSha, candidates);
    if (pushed === null || pushed === 'unknown') return null;
    if (!ZERO_SHA.test(update.oldSha)) {
      const before = await manifestBlob(quarantine, update.oldSha, candidates);
      // The push does not change the file: nothing to check.
      if (before !== 'unknown' && before?.blob === pushed.blob) return null;
    }
    const shown = await quarantineGit(quarantine, ['cat-file', 'blob', pushed.blob]);
    if (shown.exitCode !== 0) return null;
    try {
      parseManifestText(shown.stdout);
      return null;
    } catch (err) {
      if (!isManifestSyntaxError(err)) return null;
      const error: PushedManifestError = { path: pushed.path, message: err.message };
      if (err.line !== undefined) error.line = err.line;
      if (err.column !== undefined) error.column = err.column;
      return error;
    }
  } finally {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The syntax error of the manifest a push to the default branch would land,
 * or null: the file parses, the push does not change it, or the check could
 * not decide (it never blocks on its own failure).
 */
export async function pushedManifestSyntaxError(
  project: GitBackedProject,
  update: { oldSha: string; newSha: string },
  pack: Uint8Array,
): Promise<PushedManifestError | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('[git-proxy] push manifest check timed out; the push is forwarded', { projectId: project.projectId });
      resolve(null);
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      check(project, update, pack).catch((error) => {
        logger.warn('[git-proxy] push manifest check failed; the push is forwarded', {
          projectId: project.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The one-line reason git prints after `! [remote rejected]`. */
export function pushedManifestRefusal(error: PushedManifestError): string {
  const at = error.line ? `${error.path}:${error.line}${error.column ? `:${error.column}` : ''}` : error.path;
  return `${at} is not valid YAML (${error.message}). Fix it, check with \`kortix validate\`, and push again`;
}
