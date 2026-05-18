import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getStarterFiles, type StarterFile } from '@kortix/starter';

export interface ScaffoldInput {
  /** Absolute path of the destination directory. Must already exist. */
  repoRoot: string;
  /** Display name written into kortix.toml + README. */
  projectName: string;
  /** Optional "owner/repo" placeholder for README clone URL. */
  repoFullName?: string;
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
  });

  const written: string[] = [];
  const skipped: string[] = [];

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
