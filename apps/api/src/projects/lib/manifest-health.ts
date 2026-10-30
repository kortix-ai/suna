// The manifest health of GET /projects/:id/detail (`config.manifest_health`).
//
// There is one manifest format and it has no version, so a client never
// parses the manifest to decide anything: it renders this. `issues` are the
// validator's (`validateManifest`), errors first. A running project never stops
// on one: it applies the file without the broken part (`usableManifest`), so
// `issues` says what is off and how to fix it.

import type { ManifestIssue } from '@kortix/manifest-schema';

/** The most issues a health report (and a compiled agent set's `manifest_issues`) lists. */
export const MANIFEST_ISSUE_LIMIT = 50;

/** A validation issue and the repo file it is in (absent: the root manifest). */
export type FileManifestIssue = ManifestIssue & { file?: string };
/** One reported issue: a validation issue without its internal flags, plus its file and its deprecation fix id. */
export type ReportedManifestIssue = Pick<ManifestIssue, 'path' | 'message' | 'severity' | 'line' | 'column' | 'fix'> & { file?: string };

/** `issues` as reported: errors first, at most `MANIFEST_ISSUE_LIMIT`. */
export function reportedManifestIssues(issues: readonly FileManifestIssue[]): ReportedManifestIssue[] {
  return [...issues.filter((i) => i.severity === 'error'), ...issues.filter((i) => i.severity !== 'error')]
    .slice(0, MANIFEST_ISSUE_LIMIT)
    .map(({ path, message, severity, line, column, fix, file }) => ({
      path,
      message,
      severity,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
      ...(fix !== undefined ? { fix } : {}),
      ...(file !== undefined ? { file } : {}),
    }));
}

export type ManifestHealthState =
  /** The manifest validates with no issue. */
  | 'ok'
  /** The manifest has at least one error or warning. */
  | 'issues'
  /** No manifest file. Valid: the project runs its built-in agents only. */
  | 'missing'
  /** The repository read failed. */
  | 'unreadable'
  /** Hidden from this caller — no `project.file.read`. */
  | 'restricted'
  /** The GitHub App can no longer reach the repository (KRTX-2955). The
   *  project's `git_connection` carries the reason and the fix. */
  | 'repository_disconnected';

export interface ManifestHealth {
  /** Repo path the manifest was read from; null when none was read. */
  path: string | null;
  state: ManifestHealthState;
  errors: number;
  warnings: number;
  /** Errors first, at most `MANIFEST_ISSUE_LIMIT`. `errors` / `warnings` count all of them. */
  issues: ReportedManifestIssue[];
}

/** A health with no issues to report: every state but `ok` / `issues`. */
export function manifestHealthWithout(
  state: Exclude<ManifestHealthState, 'ok' | 'issues'>,
  path: string | null = null,
): ManifestHealth {
  return { path, state, errors: 0, warnings: 0, issues: [] };
}

/** The health of a manifest that was read, from its validation issues. */
export function manifestHealthOf(path: string, issues: readonly FileManifestIssue[]): ManifestHealth {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    path,
    state: issues.length === 0 ? 'ok' : 'issues',
    errors,
    warnings: issues.length - errors,
    issues: reportedManifestIssues(issues),
  };
}
