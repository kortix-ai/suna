/**
 * Config mode (docs/specs/config-releases.md, "Config mode" and "Workspace
 * report").
 *
 * The daemon posts a workspace report with each descriptor request. The API
 * chooses `follow-base` or `session-files` from it. The API never calls back
 * into the box.
 */

import { z } from '@hono/zod-openapi';
import type { GitBackedProject } from '../projects/git/types';
import type { ConfigMode, ConfigRelease } from './builder';

const HEX40 = /^[0-9a-f]{40}$/;
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
    blob: z.string().regex(HEX40).nullable(),
  })
  .strict()
  .refine((change) => (change.status === 'deleted') === (change.blob === null), {
    message: 'blob is null exactly when status is deleted',
    path: ['blob'],
  });

export const WorkspaceReportSchema = z
  .object({
    head: z.string().regex(HEX40),
    config_dir: repoPath,
    changed: z.array(WorkspaceChangeSchema).max(MAX_WORKSPACE_REPORT_ENTRIES),
  })
  .strict();

export type WorkspaceReport = z.infer<typeof WorkspaceReportSchema>;

/** `{ "workspace": WorkspaceReport | null }`. A missing `workspace` reads as null. */
export const ConfigReleaseRequestSchema = z
  .object({
    workspace: WorkspaceReportSchema.nullable().optional(),
  })
  .strict();

export interface DecideConfigModeInput {
  project: GitBackedProject;
  /** The base branch tip the release was built from. */
  baseSha: string;
  release: ConfigRelease;
  report: WorkspaceReport | null;
}

/**
 * SEAM for implementation step 4 ("Config mode in the API").
 *
 * Step 4 fills this body with the rules in the spec's "Config mode" section:
 * ignore platform-written paths, ignore paths whose blob matches any commit
 * of the base branch, and choose `session-files` for any other change.
 *
 * Until then every session follows the base branch. A missing report always
 * means `follow-base`.
 */
export async function decideConfigMode(input: DecideConfigModeInput): Promise<ConfigMode> {
  void input;
  return 'follow-base';
}
