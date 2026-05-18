/**
 * Kortix project starter — folder-based template.
 *
 * The starter is just a directory of real files under `templates/base/`.
 * `getStarterFiles()` walks that directory, applies `{{var}}`
 * substitutions, and returns `[{ path, content }]` so callers (the
 * API's create-repo flow, the `kortix init` CLI) can do whatever they
 * want with the result — commit to GitHub, write to disk, render a
 * preview.
 *
 * Editing the starter is plain file editing — change something under
 * `templates/base/` and both the API and the CLI pick it up.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface StarterFile {
  /** Repo-relative path (POSIX-separated, no leading slash). */
  path: string;
  /** UTF-8 content with `{{var}}` placeholders resolved. */
  content: string;
}

export interface StarterVars {
  /** Human display name for the project (e.g. "Company OS"). */
  projectName: string;
  /** "owner/repo" GitHub identifier. Optional — defaults to "your-org/your-repo". */
  repoFullName?: string;
}

/** Absolute path to the bundled base template directory. */
export const BASE_TEMPLATE_DIR = join(import.meta.dir, '..', 'templates', 'base');

/**
 * Walk the base template and return every file with `{{var}}`
 * placeholders resolved. Output is sorted by path for stable commit
 * ordering — both the API and CLI rely on that.
 */
export function getStarterFiles(vars: StarterVars): StarterFile[] {
  const resolvedVars: Required<StarterVars> = {
    projectName: vars.projectName,
    repoFullName: vars.repoFullName ?? 'your-org/your-repo',
  };

  const files = walk(BASE_TEMPLATE_DIR).map((absPath) => {
    const rel = relative(BASE_TEMPLATE_DIR, absPath).split(sep).join('/');
    const raw = readFileSync(absPath, 'utf8');
    return { path: rel, content: interpolate(raw, resolvedVars) };
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Replace `{{name}}` placeholders. Only `\w+` identifiers — keeps
 * accidental matches in code/docs (e.g. `{{ body.action }}` in a
 * trigger prompt) from being treated as substitution targets.
 */
function interpolate(input: string, vars: Required<StarterVars>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (name in vars) return (vars as Record<string, string>)[name]!;
    return match; // leave unknown placeholders intact
  });
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}
