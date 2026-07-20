import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getStarterFiles, type StarterFile, type StarterTemplateId } from '@kortix/starter';

import { reconcileLegacyOpencodeSymlink } from './agents.ts';

export interface ScaffoldInput {
  /** Absolute path of the destination directory. Must already exist. */
  repoRoot: string;
  /** Display name written into kortix.yaml + README. */
  projectName: string;
  /** Optional "owner/repo" placeholder for README clone URL. */
  repoFullName?: string;
  /** Starter variant. Defaults to the minimal Kortix runtime floor. */
  template?: StarterTemplateId;
  /**
   * If true, skip writing any file whose path already exists at the
   * destination. Used by `kortix init` against a repo that may already
   * have a partial layout (e.g. an existing `.opencode/`). Default is
   * false — overwrite everything.
   */
  preserveExisting?: boolean;
}

export interface ScaffoldResult {
  written: string[];
  skipped: string[];
}

/**
 * Walk the bundled `@kortix/starter` template and write every file into
 * `repoRoot`. Respects `preserveExisting` so the `init` command can
 * scaffold without clobbering a user's in-progress edits.
 */
export function applyScaffold(input: ScaffoldInput): ScaffoldResult {
  const files: StarterFile[] = getStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: input.template,
  });

  const written: string[] = [];
  const skipped: string[] = [];

  // A legacy `.opencode` symlink (pre-1.x scaffold, pointing at
  // `.kortix/opencode`) must never be written *through* here — this loop is
  // about to create the canonical real `.opencode` directory, which
  // supersedes that compat link outright, whether or not its old target
  // still exists. `keepIfTargetExists: false` is what makes this seam
  // different from `wireCodingAgents`'s steady-state reconciliation, which
  // keeps the link alive for an un-migrated repo. A user's own custom
  // symlink to anywhere else is left completely alone.
  const legacySkip = reconcileLegacyOpencodeSymlink(input.repoRoot, { keepIfTargetExists: false });
  if (legacySkip) skipped.push(legacySkip);

  for (const file of files) {
    const abs = resolve(input.repoRoot, file.path);
    if (input.preserveExisting && existsSync(abs)) {
      skipped.push(file.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, 'utf8');
    written.push(file.path);
  }

  return { written, skipped };
}
