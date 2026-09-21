/**
 * Config mode (docs/specs/config-releases.md, "Config mode" and "Workspace
 * report").
 *
 * The daemon posts a workspace report with each descriptor request. The API
 * chooses `follow-base` or `session-files` from it. The API never calls back
 * into the box.
 */

import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { refreshMirror, runGitCapture } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { managedSkillOverlayFiles } from '../runtime-assets/managed-skills';
import type { ConfigMode, ConfigRelease } from './builder';

/** A Git object ID: SHA-1 (40 hex) or SHA-256 (64 hex) repositories. */
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Bounds on the report, so one request cannot make the API walk an unbounded list. */
export const MAX_WORKSPACE_REPORT_ENTRIES = 5_000;
const MAX_PATH_LENGTH = 4_096;

const repoPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((path) => !path.startsWith('/') && !path.split('/').some((part) => part === '..' || part === ''), {
    message: 'must be a repo-relative path',
  });

export const WorkspaceChangeSchema = z
  .object({
    path: repoPath,
    status: z.enum(['modified', 'added', 'deleted', 'untracked']),
    blob: z.string().regex(GIT_OID).nullable(),
  })
  .strict()
  .refine((change) => (change.status === 'deleted') === (change.blob === null), {
    message: 'blob is null exactly when status is deleted',
    path: ['blob'],
  });

/** Bound on `package_json`. A config dir `package.json` is a few hundred bytes. */
export const MAX_REPORTED_PACKAGE_JSON_BYTES = 256 * 1024;

export const WorkspaceReportSchema = z
  .object({
    head: z.string().regex(GIT_OID),
    config_dir: repoPath,
    changed: z.array(WorkspaceChangeSchema).max(MAX_WORKSPACE_REPORT_ENTRIES),
    /**
     * What committed changes cover. `remote`: since the merge base with the
     * remote base branch. `base-sha`: since `KORTIX_BASE_SHA`. `none`: the box
     * has no base commit locally, so committed changes are not listed and the
     * mode is decided from uncommitted changes only. Optional: a report
     * without it is read as complete.
     */
    committed_scope: z.enum(['remote', 'base-sha', 'none']).optional(),
    /**
     * Optional, additive to the spec's report: the working-tree text of
     * `<config_dir>/package.json` when that file is in `changed`. The API needs
     * the text to apply the plugin-pin rule, and an uncommitted file is not in
     * the mirror. The API uses it only when its Git blob ID equals the reported
     * blob. Without it the API reads the blob from the mirror, and a blob the
     * mirror lacks counts as session work.
     */
    package_json: z.string().max(MAX_REPORTED_PACKAGE_JSON_BYTES).nullable().optional(),
  })
  .strict();

export type WorkspaceReport = z.infer<typeof WorkspaceReportSchema>;

/** `{ "workspace": WorkspaceReport | null }`. A missing `workspace` reads as null. */
export const ConfigReleaseRequestSchema = z
  .object({
    workspace: WorkspaceReportSchema.nullable().optional(),
  })
  .strict();


/**
 * History depth per path: the newest 1,000 commits of the base branch that
 * touched the path. A file an old sync left behind or an agent swept into a
 * commit is base content from the weeks before; a config file with more than
 * 1,000 base revisions is not a real case. Beyond the cap, a match is missed
 * and the path counts as session work (safe direction: the session keeps its
 * own files).
 */
export const BASE_HISTORY_DEPTH = 1_000;
/**
 * Bound on distinct history lookups per request, one `git log` each. A report
 * that needs more counts as session work. A real session reports tens of
 * paths; the bound stops one request from spawning 5,000 Git processes.
 */
export const MAX_HISTORY_LOOKUPS_PER_REQUEST = 200;

const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin';
/** Written by OpenCode's installer next to `package.json` on every spawn. */
export const INSTALLER_LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json'] as const;
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** Git writes an all-zero blob ID for the absent side of an add or a delete. */
const NULL_BLOB = /^0+$/;
/** Stands for "the path is absent" in a blob set. */
const ABSENT = '';

let managedSkillNamesMemo: ReadonlySet<string> | null = null;
/** Directory names the managed-skill overlay writes under `skills/`. Source: `managedSkillOverlayFiles`. */
export function managedSkillNames(): ReadonlySet<string> {
  if (!managedSkillNamesMemo) {
    managedSkillNamesMemo = new Set(managedSkillOverlayFiles().map((file) => file.path.split('/')[0]!).filter(Boolean));
  }
  return managedSkillNamesMemo;
}

/** Git blob ID of `text`: SHA-1 by default, SHA-256 for a SHA-256 repository. */
export function gitBlobId(text: string | Buffer, format: 'sha1' | 'sha256' = 'sha1'): string {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * `package.json` without the plugin pin, canonicalized, or null when it does
 * not parse as a JSON object. A dependency section that the removal empties
 * counts as absent: OpenCode adds the section when the repository had none.
 */
export function packageJsonWithoutPluginPin(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    for (const section of DEPENDENCY_SECTIONS) {
      const deps = object[section];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      delete (deps as Record<string, unknown>)[OPENCODE_PLUGIN_PACKAGE];
      if (Object.keys(deps).length === 0) delete object[section];
    }
    return JSON.stringify(canonical(object));
  } catch {
    return null;
  }
}

/** Sort object keys recursively, so key order is not an edit. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' };

/**
 * Every blob ID `path` had at a commit of the base branch, newest
 * `BASE_HISTORY_DEPTH` revisions. `ABSENT` is in the set when the base branch
 * deleted the path at some commit, or when the path is absent at the tip. The
 * state before the path was first added does NOT count: otherwise deleting
 * any file added after the root commit would read as base content.
 */
async function baseBlobsOf(mirror: string, tip: string, path: string): Promise<Set<string>> {
  const blobs = new Set<string>();
  // `-m`: a merge commit's own changes (a conflict resolution) count as base
  // content too. `--no-renames`: a rename is a delete plus an add.
  const log = await runGitCapture(
    ['log', `-n${BASE_HISTORY_DEPTH}`, '-m', '--format=', '--raw', '--no-abbrev', '--no-renames', tip, '--', path],
    mirror,
    null,
    LITERAL_PATHSPECS,
  );
  if (log.exitCode !== 0) throw new Error(`git log ${path} failed: ${log.stderr.trim()}`);
  for (const row of log.stdout.split('\n')) {
    const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(row);
    if (!match) continue;
    const [, before, after] = match;
    if (!NULL_BLOB.test(before!)) blobs.add(before!);
    blobs.add(NULL_BLOB.test(after!) ? ABSENT : after!);
  }
  const atTip = await runGitCapture(['rev-parse', '--verify', '--quiet', `${tip}:${path}`], mirror, null, LITERAL_PATHSPECS);
  blobs.add(atTip.exitCode === 0 ? atTip.stdout.trim() : ABSENT);
  return blobs;
}

/** Base history is immutable per `(project, tip, path)`, so it is cached across requests. */
const MAX_CACHED_HISTORIES = 20_000;
const histories = new Map<string, Promise<Set<string>>>();

function cachedBaseBlobs(projectId: string, mirror: string, tip: string, path: string): Promise<Set<string>> {
  const key = `${projectId}\0${tip}\0${path}`;
  const hit = histories.get(key);
  if (hit) {
    histories.delete(key);
    histories.set(key, hit);
    return hit;
  }
  const next = baseBlobsOf(mirror, tip, path);
  histories.set(key, next);
  next.catch(() => histories.delete(key));
  while (histories.size > MAX_CACHED_HISTORIES) histories.delete(histories.keys().next().value as string);
  return next;
}

export function __clearConfigModeCachesForTests(): void {
  histories.clear();
}

export interface DecideConfigModeInput {
  project: GitBackedProject;
  /** The base branch tip the release was built from. */
  baseSha: string;
  release: ConfigRelease;
  report: WorkspaceReport | null;
  /** Tests only. Defaults to `managedSkillNames()`. */
  managedSkills?: ReadonlySet<string>;
  /** Tests only. Defaults to `MAX_HISTORY_LOOKUPS_PER_REQUEST`. */
  maxHistoryLookups?: number;
}

export interface ConfigModeDecision {
  mode: ConfigMode;
  /** The first path that counts as session work, or null for `follow-base`. */
  sessionPath: string | null;
  /**
   * A gap in the report the decision could not see, or null. The descriptor
   * route puts it in `reason` when the release has none, so the gap is
   * visible in the descriptor and not silent.
   */
  note: string | null;
}

/** The descriptor `reason` for a report with `committed_scope: "none"`. */
export const COMMITTED_SCOPE_NONE_NOTE =
  'the sandbox could not list committed config changes (committed_scope none); the mode was decided from uncommitted changes only';

/**
 * Choose the config mode from the workspace report (spec, "Config mode").
 *
 * A path is ignored when:
 *   1. The platform wrote it: `package.json` whose only difference from a base
 *      revision is the `@opencode-ai/plugin` pin; an installer lockfile while
 *      `package.json` holds no other edit; any path under `skills/<name>/`
 *      where the managed overlay ships `<name>`.
 *   2. Its blob ID equals that path's blob at a commit of the base branch
 *      (`baseBlobsOf`). An old sync left it, or an agent's `git add -A`
 *      committed it. It is base content, not an edit.
 * Any other path is session work: `session-files`. No report: `follow-base`.
 */
export async function decideConfigMode(input: DecideConfigModeInput): Promise<ConfigMode> {
  return (await explainConfigMode(input)).mode;
}

export async function explainConfigMode(input: DecideConfigModeInput): Promise<ConfigModeDecision> {
  const report = input.report;
  const note = report?.committed_scope === 'none' ? COMMITTED_SCOPE_NONE_NOTE : null;
  const followBase: ConfigModeDecision = { mode: 'follow-base', sessionPath: null, note };
  if (!report || report.changed.length === 0) return followBase;
  const sessionFiles = (path: string): ConfigModeDecision => ({ mode: 'session-files', sessionPath: path, note });

  const configDir = report.config_dir.replace(/\/+$/, '');
  const prefix = `${configDir}/`;
  const managed = input.managedSkills ?? managedSkillNames();
  const packageJsonPath = `${prefix}package.json`;
  const lockfilePaths = new Set(INSTALLER_LOCKFILES.map((name) => `${prefix}${name}`));

  const isManagedSkill = (path: string): boolean => {
    const rest = path.slice(prefix.length).split('/');
    return rest.length >= 3 && rest[0] === 'skills' && managed.has(rest[1]!);
  };

  // Cheap rules first: a report of platform dirt only needs no Git at all.
  const candidates = report.changed.filter((change) => change.path.startsWith(prefix) && !isManagedSkill(change.path));
  if (candidates.length === 0) return followBase;

  const mirror = await refreshMirror(input.project);
  let lookups = 0;
  const historyOf = async (path: string): Promise<Set<string> | null> => {
    if (++lookups > (input.maxHistoryLookups ?? MAX_HISTORY_LOOKUPS_PER_REQUEST)) return null;
    return cachedBaseBlobs(input.project.projectId, mirror, input.baseSha, path);
  };

  const readBlob = async (blob: string): Promise<string | null> => {
    const shown = await runGitCapture(['cat-file', 'blob', blob], mirror);
    return shown.exitCode === 0 ? shown.stdout : null;
  };

  // Does `package.json` differ from some base revision by the plugin pin at most?
  let packageJsonPlatformOnlyMemo: Promise<boolean> | null = null;
  const packageJsonPlatformOnly = (): Promise<boolean> =>
    (packageJsonPlatformOnlyMemo ??= (async () => {
      const entry = report.changed.find((change) => change.path === packageJsonPath);
      // Not in the report: the file equals the merge base, which is a base revision.
      if (!entry) return true;
      if (entry.blob === null) return false;
      const reported = report.package_json;
      const format = entry.blob.length === 64 ? 'sha256' : 'sha1';
      const text =
        typeof reported === 'string' && gitBlobId(reported, format) === entry.blob
          ? reported
          : await readBlob(entry.blob);
      const mine = packageJsonWithoutPluginPin(text);
      if (mine === null) return false;
      const history = await historyOf(packageJsonPath);
      if (!history) return false;
      for (const blob of history) {
        if (blob === ABSENT) continue;
        if (packageJsonWithoutPluginPin(await readBlob(blob)) === mine) return true;
      }
      return false;
    })());

  for (const change of candidates) {
    const path = change.path;
    if ((path === packageJsonPath || lockfilePaths.has(path)) && (await packageJsonPlatformOnly())) continue;
    const history = await historyOf(path);
    if (history && history.has(change.blob ?? ABSENT)) continue;
    return sessionFiles(path);
  }
  return followBase;
}
